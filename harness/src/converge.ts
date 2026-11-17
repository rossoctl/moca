import type { SandboxTransport } from '@moca/k8s-sandbox';

/** Single-quote-escape a string for safe interpolation into a bash command. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The per-leaf worktree path inside the sandbox pod. */
export function leafWorkspaceRef(sessionId: string): string {
  return `/workspace/leaves/${sessionId}`;
}

/**
 * Ref-pinned lazy converge (spec §5): maintain a single shared object store at /workspace/repo and
 * fetch the target ref *by explicit URL* under a per-pod flock (serializes concurrent converges),
 * then add a per-leaf detached worktree at the fetched commit. Idempotent — a pod already holding
 * the ref and worktree is a no-op. Prints the worktree path on stdout.
 *
 * Fetching by URL (not a fixed `origin`) lets one pooled sandbox serve many repos: the first
 * converge no longer binds /workspace/repo to its repoUrl (#67). init+fetch run entirely under the
 * flock so concurrent leaves on a fresh workspace don't race, and a missing/corrupt repo self-heals
 * via rm -rf + git init (a failed fetch retries once), closing the non-self-healing wedge in #59.
 */
export function buildConvergeScript(repoUrl: string, ref: string, sessionId: string): string {
  const LEAF = leafWorkspaceRef(sessionId);
  const fetch = `git -C "$REPO" fetch --quiet ${sq(repoUrl)} ${sq(ref)}`;
  const init = `rm -rf "$REPO"; git init -q "$REPO"`;
  return [
    `set -eu`,
    `REPO=/workspace/repo; LOCK=/workspace/.sh-fetch.lock; LEAF=${sq(LEAF)}`,
    `mkdir -p /workspace/leaves`,
    `(`,
    `  flock 9`,
    `  [ -d "$REPO/.git" ] || { ${init}; }`,
    `  ${fetch} || { ${init}; ${fetch}; }`,
    // Ignore an untracked `.sh-config` under any worktree: on a solve leaf with a configRef the
    // promoted-config overlay symlinks `.sh-config` into the leaf dir, and without this
    // `git add -A` in buildDiffCaptureScript would stage that symlink into every captured patch.
    // Written on every converge (harmless when no overlay runs — the entry just has no match).
    // `mkdir -p "$REPO/.git/info"` guards against a missing templates dir: `git init` normally
    // creates it, but if it isn't there `echo >>` fails under `set -eu` and takes down the whole
    // converge. Append is idempotent via `grep -qxF` on the exact line.
    `  mkdir -p "$REPO/.git/info"`,
    `  grep -qxF .sh-config "$REPO/.git/info/exclude" 2>/dev/null || `,
    `    echo .sh-config >> "$REPO/.git/info/exclude"`,
    `) 9>"$LOCK"`,
    `COMMIT=$(git -C "$REPO" rev-parse FETCH_HEAD)`,
    // The pinned commit is recorded next to the worktree, not inside it: `buildDiffCaptureScript`
    // diffs against THIS, because by capture time the leaf's own HEAD may be a commit the model made
    // -- a sha nobody outside the sandbox has, and one that hides its own changes from the diff. A
    // sibling path rather than a file in the tree, so `git add -A` can never stage it. Written only
    // when the worktree is created, so a re-converge onto an existing leaf keeps the original base.
    `[ -d "$LEAF" ] || { git -C "$REPO" worktree add --quiet --detach "$LEAF" "$COMMIT"; printf '%s\\n' "$COMMIT" >"$LEAF.base"; }`,
    `printf '%s' "$LEAF"`,
  ].join('\n');
}

/** Remove the per-leaf worktree and prune orphans (best-effort; never fails the leaf). */
export function buildCleanupScript(sessionId: string): string {
  const LEAF = leafWorkspaceRef(sessionId);
  return [
    `set -u`,
    `REPO=/workspace/repo; LEAF=${sq(LEAF)}`,
    `git -C "$REPO" worktree remove --force "$LEAF" 2>/dev/null || rm -rf "$LEAF"`,
    `rm -f "$LEAF.base"`,
    `git -C "$REPO" worktree prune 2>/dev/null || true`,
  ].join('\n');
}

/** Run the converge script in the pod; return the worktree ref. Throws on non-zero exit. */
export async function convergeWorkspace(
  transport: SandboxTransport,
  repoUrl: string,
  ref: string,
  sessionId: string,
): Promise<string> {
  const { stdout, exitCode, truncated } = await transport.exec(
    buildConvergeScript(repoUrl, ref, sessionId),
    {
      timeout: 300,
    },
  );
  if (truncated)
    throw new Error(
      `converge exceeded the sandbox output cap (converge output too large): ${sessionId}`,
    );
  if (exitCode !== 0) throw new Error(`converge failed (exit ${exitCode})`);
  return stdout.toString().trim() || leafWorkspaceRef(sessionId);
}

/** Best-effort worktree cleanup; swallows errors so it never masks a verdict. */
export async function cleanupWorkspace(
  transport: SandboxTransport,
  sessionId: string,
): Promise<void> {
  try {
    await transport.exec(buildCleanupScript(sessionId), { timeout: 60 });
  } catch {
    /* ignore */
  }
}

/**
 * A captured patch and the commit it applies to (#390). The baseline is what makes the patch
 * usable: `git apply` needs the tree the diff was taken against, and a leaf's workspace is gone by
 * the time a caller reads the result.
 */
export interface WorkspaceDiff {
  patch: string;
  baseline: string;
}

/**
 * Print the baseline commit, then stage every edit in the leaf worktree and print the resulting
 * unified diff (vs the pinned base). The baseline goes FIRST, as `buildPatchCaptureScript` already
 * does it for a templated turn, so one exec yields both and the two cannot describe different trees.
 *
 * The baseline is the commit `buildConvergeScript` pinned, read back from `$LEAF.base`, NOT the
 * leaf's current HEAD: an agent that ran `git commit` in its worktree moves HEAD to a sha that
 * exists only inside that sandbox, and `diff --cached` against it would also leave the committed
 * work out of the patch entirely. Diffing the index against the pinned commit covers committed,
 * staged and untracked changes alike. `rev-parse HEAD` stays as the fallback, for a worktree a
 * pre-#390 converge created without the file.
 */
export function buildDiffCaptureScript(sessionId: string): string {
  const LEAF = leafWorkspaceRef(sessionId);
  return [
    `set -eu`,
    `LEAF=${sq(LEAF)}`,
    `BASE=$(cat "$LEAF.base" 2>/dev/null || git -C "$LEAF" rev-parse HEAD)`,
    `printf '%s\\n' "$BASE"`,
    `git -C "$LEAF" add -A`,
    `git -C "$LEAF" diff --cached "$BASE"`,
  ].join('\n');
}

/** Run the diff-capture script in the pod; return the patch (possibly empty) and its baseline. */
export async function captureWorkspaceDiff(
  transport: SandboxTransport,
  sessionId: string,
): Promise<WorkspaceDiff> {
  const { stdout, exitCode, truncated } = await transport.exec(buildDiffCaptureScript(sessionId), {
    timeout: 120,
  });
  if (truncated)
    throw new Error(`diff capture exceeded the sandbox output cap (diff too large): ${sessionId}`);
  if (exitCode !== 0) throw new Error(`diff capture failed (exit ${exitCode})`);
  return splitBaseline(stdout.toString());
}

/**
 * The baseline off the first line, the patch off the rest. The patch must NOT keep the sha: a
 * `diff --git` preceded by a stray line is rejected by `git apply`, which is the one failure this
 * whole capture exists to avoid.
 */
export function splitBaseline(raw: string): WorkspaceDiff {
  const nl = raw.indexOf('\n');
  const baseline = (nl < 0 ? raw : raw.slice(0, nl)).trim();
  const patch = nl < 0 ? '' : raw.slice(nl + 1);
  // A unified diff must end with a newline. `git diff` emits one, but some exec transports strip
  // the trailing newline from captured stdout — and a patch that ends mid-line is rejected by
  // `git apply` / GNU patch ("patch unexpectedly ends in middle of line"), so the captured
  // model_patch fails to apply during offline evaluation. Restore it for a non-empty patch.
  return { baseline, patch: patch && !patch.endsWith('\n') ? patch + '\n' : patch };
}
