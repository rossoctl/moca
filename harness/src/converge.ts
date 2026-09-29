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
    `) 9>"$LOCK"`,
    `COMMIT=$(git -C "$REPO" rev-parse FETCH_HEAD)`,
    `[ -d "$LEAF" ] || git -C "$REPO" worktree add --quiet --detach "$LEAF" "$COMMIT"`,
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

/** Stage every edit in the leaf worktree and print the resulting unified diff (vs the pinned base). */
export function buildDiffCaptureScript(sessionId: string): string {
  const LEAF = leafWorkspaceRef(sessionId);
  return [
    `set -eu`,
    `LEAF=${sq(LEAF)}`,
    `git -C "$LEAF" add -A`,
    `git -C "$LEAF" diff --cached`,
  ].join('\n');
}

/** Run the diff-capture script in the pod; return the patch (possibly empty). Throws on non-zero exit. */
export async function captureWorkspaceDiff(
  transport: SandboxTransport,
  sessionId: string,
): Promise<string> {
  const { stdout, exitCode, truncated } = await transport.exec(buildDiffCaptureScript(sessionId), {
    timeout: 120,
  });
  if (truncated)
    throw new Error(`diff capture exceeded the sandbox output cap (diff too large): ${sessionId}`);
  if (exitCode !== 0) throw new Error(`diff capture failed (exit ${exitCode})`);
  const patch = stdout.toString();
  // A unified diff must end with a newline. `git diff` emits one, but some exec transports strip
  // the trailing newline from captured stdout — and a patch that ends mid-line is rejected by
  // `git apply` / GNU patch ("patch unexpectedly ends in middle of line"), so the captured
  // model_patch fails to apply during offline evaluation. Restore it for a non-empty patch.
  return patch && !patch.endsWith('\n') ? patch + '\n' : patch;
}
