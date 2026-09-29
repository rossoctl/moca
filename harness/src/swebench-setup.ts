import type { SandboxTransport } from '@moca/k8s-sandbox';

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** env_dir = env_key with a trailing ":latest" tag stripped (dots kept). */
export function envDirFromKey(envKey: string): string {
  return envKey.endsWith(':latest') ? envKey.slice(0, -':latest'.length) : envKey;
}
export function swebenchCheckoutDir(sessionId: string): string {
  return `/workspace/co-${sessionId}`;
}
export function swebenchVenvDir(sessionId: string): string {
  return `/workspace/venv-${sessionId}`;
}

/**
 * SWE-bench per-leaf provisioning inside the shared pool pod (mirrors the merged
 * measure-swebench-runtimes.sh mechanism — moved to rossoctl/moca-experiments as
 * knative/measure-swebench-runtimes.sh on 2026-09-25 — see that file's header for
 * the rationale behind every choice). Clones the baked bare mirror cross-device
 * (--no-hardlinks: /repos overlay -> /workspace EBS), checks out base_commit, layers
 * a per-leaf system-site venv over the baked conda env, and editable-installs the
 * repo (build-iso fallback). Prints the checkout dir on stdout.
 */
export function buildSwebenchSetupScript(a: {
  repoUrl: string;
  baseCommit: string;
  envKey: string;
  sessionId: string;
}): string {
  const CO = swebenchCheckoutDir(a.sessionId);
  const VENV = swebenchVenvDir(a.sessionId);
  const ENV_PY = `/opt/miniconda3/envs/${envDirFromKey(a.envKey)}/bin/python`;
  return [
    `set -eu`,
    `CO=${sq(CO)}`,
    `VENV=${sq(VENV)}`,
    `rm -rf "$CO" "$VENV"`,
    `git clone --no-hardlinks ${sq(a.repoUrl)} "$CO" >&2`,
    `git -C "$CO" checkout -q ${sq(a.baseCommit)}`,
    `${sq(ENV_PY)} -m venv --system-site-packages "$VENV" >&2`,
    `HOME=/workspace "$VENV/bin/pip" install -e "$CO" --no-build-isolation --no-cache-dir >&2 \\`,
    `  || HOME=/workspace "$VENV/bin/pip" install -e "$CO" --no-cache-dir >&2`,
    `printf '%s' "$CO"`,
  ].join('\n');
}

export function buildSwebenchDiffScript(sessionId: string): string {
  const CO = swebenchCheckoutDir(sessionId);
  return [`set -eu`, `git -C ${sq(CO)} add -A`, `git -C ${sq(CO)} diff --cached`].join('\n');
}
export function buildSwebenchCleanupScript(sessionId: string): string {
  return [
    `set -u`,
    `rm -rf ${sq(swebenchCheckoutDir(sessionId))} ${sq(swebenchVenvDir(sessionId))}`,
  ].join('\n');
}

export function buildSwebenchSolvePrompt(
  problemStatement: string,
  checkoutDir: string,
  venvPython: string,
): string {
  let end = checkoutDir.length;
  while (end > 0 && checkoutDir.charCodeAt(end - 1) === 47) end--;
  const root = checkoutDir.slice(0, end);
  return [
    `You are fixing a software issue in a checked-out Python repository.`,
    `Repository root (an absolute path in your sandbox): ${root}`,
    `The repository is installed (editable) into a virtualenv. Run its tests with this interpreter:`,
    `  ${venvPython} -m pytest ...`,
    `Use your bash, read, and edit tools with absolute paths under the repository root.`,
    ``,
    `## Issue`,
    problemStatement,
    ``,
    `Implement a fix by editing files under ${root}. When you are confident the fix is complete,`,
    `stop — do not ask questions and do not call any reporting tool.`,
  ].join('\n');
}

export async function setupSwebenchWorkspace(
  t: SandboxTransport,
  a: { repoUrl: string; baseCommit: string; envKey: string; sessionId: string },
): Promise<string> {
  const { stdout, exitCode, truncated } = await t.exec(buildSwebenchSetupScript(a), {
    timeout: 900,
  });
  if (truncated) {
    throw new Error(
      `swebench setup exceeded the sandbox output cap (setup output too large): ${a.sessionId}`,
    );
  }
  if (exitCode !== 0) throw new Error(`swebench setup failed (exit ${exitCode})`);
  return stdout.toString().trim() || swebenchCheckoutDir(a.sessionId);
}
export async function captureSwebenchDiff(t: SandboxTransport, sessionId: string): Promise<string> {
  const { stdout, exitCode, truncated } = await t.exec(buildSwebenchDiffScript(sessionId), {
    timeout: 120,
  });
  if (truncated) {
    throw new Error(
      `swebench diff capture exceeded the sandbox output cap (diff too large): ${sessionId}`,
    );
  }
  if (exitCode !== 0) throw new Error(`swebench diff capture failed (exit ${exitCode})`);
  return stdout.toString();
}
export async function cleanupSwebench(t: SandboxTransport, sessionId: string): Promise<void> {
  try {
    await t.exec(buildSwebenchCleanupScript(sessionId), { timeout: 60 });
  } catch {
    /* ignore */
  }
}
