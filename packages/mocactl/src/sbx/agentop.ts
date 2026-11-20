import { execFile } from 'node:child_process';

/**
 * Cortex's agentop, as `sbx up --cortex` and `sbx doctor` use it: its version, installing the
 * moca-sandbox script plugin, and that plugin's state. moca does not depend on Cortex: nothing
 * here runs unless the repository is in Cortex mode (sbx-up-cortex spec §3, §4).
 */

/** The catalog entry `agentop script install` takes: Cortex's moca-sandbox script plugin. */
export const MOCA_SANDBOX = 'moca-sandbox';

/** The first Cortex release whose agentop has `script install` (rossoctl/cortex#1507). */
const AGENTOP_MIN_VERSION = '0.9.3';

/** What to run to get Cortex, said whenever agentop is missing or too old. */
export const CORTEX_INSTALL = 'curl -fsSL https://www.rossoctl.dev/cortex/install.sh | sh';

/** How long `agentop script install` may take: it waits for Cortex to load the slot (10 s). */
const INSTALL_TIMEOUT_MS = 60_000;
const QUICK_TIMEOUT_MS = 10_000;

/** One finished agentop run. `code` is null when it could not be started at all. */
export interface AgentopRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs agentop with `args`; tests pass their own. Never throws. */
export type AgentopExec = (args: string[], timeoutMs: number) => Promise<AgentopRun>;

export const runAgentop: AgentopExec = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      'agentop',
      args,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 2 ** 20 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
        if (e && typeof e.code === 'string') {
          resolve({
            code: null,
            stdout: '',
            stderr: e.code === 'ENOENT' ? 'agentop is not on PATH' : e.message,
          });
          return;
        }
        resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr });
      },
    );
  });

/**
 * Why this agentop cannot do what Cortex mode needs, or undefined when it can: `agentop vX.Y.Z` at
 * least AGENTOP_MIN_VERSION, a development build (`agentop dev`, `agentop dev-<rev>`), or a build
 * from Cortex's main channel (`agentop main-<sha7>`, from `install.sh --ref=main`).
 */
export async function agentopProblem(exec: AgentopExec = runAgentop): Promise<string | undefined> {
  const r = await exec(['--version'], QUICK_TIMEOUT_MS);
  if (r.code === null)
    return `${r.stderr}; Cortex mode needs Cortex v${AGENTOP_MIN_VERSION} or later`;
  const line = r.stdout.trim().split('\n')[0] ?? '';
  if (/^agentop (dev(-\S+)?|main-[0-9a-f]+)$/.test(line)) return undefined;
  const m = /^agentop v(\d+)\.(\d+)\.(\d+)/.exec(line);
  if (!m) return `agentop --version answered ${JSON.stringify(line)}, which is not a version`;
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  const want = AGENTOP_MIN_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i]! > want[i]!) return undefined;
    if (have[i]! < want[i]!) {
      return `agentop is ${line.slice('agentop '.length)}; Cortex mode needs v${AGENTOP_MIN_VERSION} or later`;
    }
  }
  return undefined;
}

/**
 * Installs the moca-sandbox script plugin into Cortex, or updates an outdated copy. Safe to repeat.
 * Resolves to agentop's own words: stdout when it worked, stderr (or why it could not run) when not.
 */
export async function installMocaSandbox(
  exec: AgentopExec = runAgentop,
): Promise<{ ok: boolean; message: string }> {
  const r = await exec(['script', 'install', MOCA_SANDBOX], INSTALL_TIMEOUT_MS);
  if (r.code === 0) return { ok: true, message: r.stdout.trim() };
  const why = (r.stderr || r.stdout).trim() || `agentop exited ${r.code ?? 'without starting'}`;
  return { ok: false, message: why };
}

/** moca-sandbox as `agentop script list --json` reports it (rossoctl/cortex#1507). */
export interface MocaSandboxStatus {
  state: string;
  scripts: number;
  /** Absent when Cortex is not running. */
  loaded?: number;
  notStarted?: number;
}

/** moca-sandbox's row from `agentop script list --json`, or why it could not be read. */
export async function mocaSandboxStatus(
  exec: AgentopExec = runAgentop,
): Promise<{ status?: MocaSandboxStatus; problem?: string }> {
  const r = await exec(['script', 'list', '--json'], QUICK_TIMEOUT_MS);
  if (r.code !== 0) {
    return { problem: (r.stderr || r.stdout).trim() || `agentop script list exited ${r.code}` };
  }
  let rows: unknown;
  try {
    rows = (JSON.parse(r.stdout) as { scripts?: unknown }).scripts;
  } catch {
    return { problem: 'agentop script list --json did not answer JSON' };
  }
  const row = Array.isArray(rows)
    ? (rows as Record<string, unknown>[]).find((x) => x && x.name === MOCA_SANDBOX)
    : undefined;
  if (!row) return { problem: `this Cortex ships no ${MOCA_SANDBOX} script plugin` };
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const status: MocaSandboxStatus = {
    state: typeof row.state === 'string' ? row.state : 'unknown',
    scripts: num(row.scripts) ?? 0,
  };
  const loaded = num(row.loaded);
  const notStarted = num(row.notStarted);
  if (loaded !== undefined) status.loaded = loaded;
  if (notStarted !== undefined) status.notStarted = notStarted;
  return { status };
}
