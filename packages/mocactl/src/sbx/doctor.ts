import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { q, type SandboxModeName } from '@moca/sandbox-client';
import { ApiError } from '../api/errors.js';
import { describeError } from '../core/messages.js';
import { sanitizeRemote } from '../core/sanitize.js';
import { ensureRuntimeAuth } from '../runtime.js';
import { CLAUDE_MIN_VERSION, checkAgentConfig, claudeTooOld, cortexMode } from './agent-config.js';
import {
  agentopProblem,
  CORTEX_INSTALL,
  MOCA_SANDBOX,
  mocaSandboxStatus,
  runAgentop,
  type AgentopExec,
} from './agentop.js';
import { notEnrolledMessage, SBX_EXIT, type SbxCtx } from './commands.js';
import { openExec, sandboxFailureText, type ExecFactory, type OpenedExec } from './exec.js';
import { PushError, sandboxState } from './push.js';
import { readRecords } from './recorder.js';

/**
 * `mocactl sbx doctor` (SBX0 §6.1): the login, the bound sandbox and its expiry, the agent
 * configuration's denied state (spec §6.3, re-checked against agent-config.ts's lists; and a Claude
 * Code too old for them, listed only then), one `true` Exec and its latency, work not yet pulled,
 * and the flight recorder's last 24 hours. One line per check, and a fix for every failure.
 */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  /** Passing, but worth a look (changes not yet pulled): never fails the run. */
  warn?: boolean;
}

const DAY_MS = 86_400_000;
const execFileAsync = promisify(execFile);
/**
 * Each of doctor's Execs (`true`, the state check): its timeout, and the client-side backstop
 * margin beyond it, so a hung relay stalls each for about 30 s at most.
 */
const EXEC_TIMEOUT_S = 20;
const EXEC_BACKSTOP_S = 10;
const UP = 'mocactl sbx up';

/** Nearest-rank percentile of `xs` (0 for none). */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

function left(ms: number): string {
  if (ms >= DAY_MS)
    return `${Math.floor(ms / DAY_MS)} d ${Math.floor((ms % DAY_MS) / 3_600_000)} h`;
  if (ms >= 3_600_000)
    return `${Math.floor(ms / 3_600_000)} h ${Math.floor((ms % 3_600_000) / 60_000)} min`;
  return `${Math.max(0, Math.floor(ms / 60_000))} min`;
}

async function loginCheck(c: SbxCtx): Promise<DoctorCheck> {
  const login = c.explicitUrl
    ? `mocactl sbx login --control-plane-url ${q(sanitizeRemote(c.url))}`
    : 'mocactl sbx login';
  let auth;
  try {
    auth = await ensureRuntimeAuth(c.rt);
  } catch (err) {
    auth = { kind: 'unreachable' as const, error: err };
  }
  if (auth.kind === 'ok') {
    const who = auth.auth.displayName ?? auth.auth.subject;
    return { name: 'login', ok: true, detail: `logged in to ${c.url} as ${who}` };
  }
  if (auth.kind === 'login_required') {
    return { name: 'login', ok: false, detail: `not logged in to ${c.url}`, fix: login };
  }
  const err = auth.error;
  if (err instanceof ApiError && err.code === 'not_enrolled') {
    return {
      name: 'login',
      ok: false,
      detail: notEnrolledMessage(err).replace(/^sbx: /, ''),
      fix: 'ask an operator to enroll this GitHub account',
    };
  }
  return {
    name: 'login',
    ok: false,
    detail: `cannot refresh the login at ${c.url}: ${describeError(err)}`,
    fix: 'check the control-plane URL and the network, then run mocactl sbx doctor again',
  };
}

/**
 * Whether the next checks can reach the sandbox: false after a sandbox failure. `mode` is the
 * record's, when it could be read, for the agent-config check's rules block.
 */
async function sandboxCheck(
  c: SbxCtx,
  id: string,
): Promise<{ check: DoctorCheck; live: boolean; mode?: SandboxModeName }> {
  const name = 'sandbox';
  let s;
  try {
    s = await c.api.getSandbox(id);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'sandbox_not_found') {
      return {
        check: { name, ok: false, detail: `${id} no longer exists`, fix: UP },
        live: false,
      };
    }
    return {
      check: {
        name,
        ok: false,
        detail: `${id}: ${describeError(err)}`,
        fix: 'check the control plane is reachable (mocactl sbx ls), then run mocactl sbx doctor again',
      },
      live: false,
    };
  }
  const template = sanitizeRemote(s.template);
  const expires = new Date(s.expiresAt * 1000).toISOString();
  if (s.state !== 'ready') {
    return {
      check: {
        name,
        ok: false,
        detail: `${id} (${template}) is terminated${s.reason ? ` (${sanitizeRemote(s.reason)})` : ''}`,
        fix: `${UP} creates a new one`,
      },
      live: false,
    };
  }
  const ms = s.expiresAt * 1000 - c.rt.now();
  const detail = `${id} (${template}) is ready; expires ${expires}, in ${left(ms)}`;
  if (ms <= DAY_MS) {
    return {
      check: {
        name,
        ok: false,
        detail: `${detail}: less than 24 h left`,
        fix:
          'pull its work before then (mocactl sbx pull --apply); for a fresh sandbox, ' +
          `mocactl sbx rm, then ${UP}`,
      },
      live: true,
      mode: s.mode,
    };
  }
  return { check: { name, ok: true, detail }, live: true, mode: s.mode };
}

/**
 * `claude --version`'s output, or undefined when Claude Code is not on PATH (or did not answer).
 * Asynchronous, so a slow `claude` never blocks the event loop. On Windows an npm-installed
 * `claude` is a `.cmd` shim, which only a shell can start; the arguments are fixed, so the shell
 * is safe there.
 */
export async function installedClaudeVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      shell: process.platform === 'win32',
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * A Claude Code too old for the deny list (`CLAUDE_DENY` names only current tools, so an older
 * one keeps `MultiEdit`, `LS` and `NotebookRead`): a failing check; undefined otherwise.
 */
function claudeVersionCheck(version: string | undefined): DoctorCheck | undefined {
  if (version === undefined || !claudeTooOld(version)) return undefined;
  return {
    name: 'claude code',
    ok: false,
    detail:
      `${version.split('\n')[0]} is older than ${CLAUDE_MIN_VERSION}: its MultiEdit, LS and ` +
      'NotebookRead tools read or edit files on this machine and are not denied',
    fix: 'update Claude Code (claude update)',
  };
}

/**
 * In Cortex mode, the check that something keeps the agent off local tools: Cortex's moca-sandbox
 * script, installed and loaded (sbx-up-cortex spec §4). Whether Claude Code reaches the model
 * through Cortex is not checked: agentop has no machine-readable answer to that.
 */
export async function cortexCheck(agentop: AgentopExec = runAgentop): Promise<DoctorCheck> {
  const name = 'cortex';
  const bad = await agentopProblem(agentop);
  if (bad) return { name, ok: false, detail: bad, fix: CORTEX_INSTALL };
  const { status: st, problem } = await mocaSandboxStatus(agentop);
  if (!st)
    return { name, ok: false, detail: problem!, fix: `agentop script install ${MOCA_SANDBOX}` };
  if (st.state !== 'installed') {
    return {
      name,
      ok: false,
      detail: `${MOCA_SANDBOX} is ${st.state}`,
      fix: `agentop script install ${MOCA_SANDBOX}`,
    };
  }
  if (st.loaded === undefined) {
    return {
      name,
      ok: false,
      detail: `Cortex is not running, so nothing keeps the agent off this machine's tools`,
      fix: 'agentop service start',
    };
  }
  if (st.loaded < st.scripts || (st.notStarted ?? 0) > 0) {
    return {
      name,
      ok: false,
      detail: `${MOCA_SANDBOX} did not start (${st.loaded} of ${st.scripts} scripts loaded)`,
      fix: "see Cortex's log; a Python script needs python3",
    };
  }
  return {
    name,
    ok: true,
    detail: `${MOCA_SANDBOX} is installed and loaded; Claude Code must reach the model through Cortex`,
  };
}

function configCheck(root: string, mode: SandboxModeName | undefined): DoctorCheck {
  const problems = checkAgentConfig(root, mode);
  return problems.length
    ? {
        name: 'agent config',
        ok: false,
        detail: problems.join('; '),
        // A problem that states its own remedy is one `up` cannot make (a conflict it refuses to
        // merge over, or settings.local.json, which it never writes): do that by hand instead.
        fix: `${UP} merges it again; where a problem above names its own fix, make that one by hand`,
      }
    : {
        name: 'agent config',
        ok: true,
        detail: cortexMode(root)
          ? "Claude Code, OpenCode and IBM Bob use the sandbox MCP server; Claude Code's local " +
            "tools left to Cortex, OpenCode's disabled in this repository's project config; " +
            'Bob has no deny list, so its own tools stay available'
          : 'Claude Code, OpenCode and IBM Bob use the sandbox MCP server, with every local tool ' +
            "denied in this repository's project config except Bob's, which has no deny list, so " +
            'its own tools stay available; user-level and managed settings are not checked',
      };
}

async function execChecks(
  c: SbxCtx,
  id: string,
  factory: ExecFactory | undefined,
): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  let x: OpenedExec | undefined;
  try {
    // Short, so a hung relay stalls doctor for about 30 s at most, not the 90 s default backstop.
    x = await openExec(c.api, id, factory, { backstopMarginS: EXEC_BACKSTOP_S });
    const t0 = c.rt.now();
    const r = await x.exec('true', {
      timeoutS: EXEC_TIMEOUT_S,
      ...(c.signal ? { signal: c.signal } : {}),
    });
    const ms = c.rt.now() - t0;
    if (r.exitCode !== 0) {
      out.push({
        name: 'exec',
        ok: false,
        detail: `\`true\` ${r.timedOutS !== undefined ? 'timed out' : `exited ${r.exitCode}`} after ${ms} ms`,
        fix: 'the template may be broken: try mocactl sbx run -- true, and tell the operators',
      });
      return out;
    }
    out.push({ name: 'exec', ok: true, detail: `one \`true\` in a fresh VM: ${ms} ms` });
  } catch (err) {
    x?.close();
    out.push({
      name: 'exec',
      ok: false,
      detail: err instanceof ApiError ? describeError(err) : sandboxFailureText(err),
      fix: 'retry in a minute; if it persists, tell the operators (mocactl sbx doctor --json)',
    });
    return out;
  }
  try {
    const s = await sandboxState(x.exec, undefined, {
      timeoutS: EXEC_TIMEOUT_S,
      ...(c.signal ? { signal: c.signal } : {}),
    });
    const detail = {
      clean: 'nothing to pull',
      empty: 'nothing to pull (never pushed)',
      dirty: 'changes not yet pulled: mocactl sbx pull --apply brings them here',
      no_baseline:
        'changes not yet pulled (files with no baseline): mocactl sbx pull shows what it can',
      incomplete: 'the last push did not finish: mocactl sbx push',
    }[s];
    out.push({
      name: 'changes',
      ok: true,
      detail,
      ...(s === 'clean' || s === 'empty' ? {} : { warn: true }),
    });
  } catch (err) {
    out.push({
      name: 'changes',
      ok: false,
      detail:
        err instanceof PushError
          ? err.message
          : err instanceof ApiError
            ? describeError(err)
            : sandboxFailureText(err),
      fix: 'retry in a minute; mocactl sbx pull shows the changes once the sandbox answers',
    });
  } finally {
    x.close();
  }
  return out;
}

function recorderCheck(c: SbxCtx, id: string): DoctorCheck {
  const since = c.rt.now() - DAY_MS;
  let all: Record<string, unknown>[];
  try {
    all = readRecords(c.rt.paths.stateDir, id);
  } catch (err) {
    return {
      name: 'recent calls',
      ok: false,
      detail: `cannot read the flight recorder: ${describeError(err)}`,
      fix: `check ${c.rt.paths.stateDir}/sbx/${id}.log is a readable file (it may be removed)`,
    };
  }
  const recs = all.filter((r) => {
    const t = typeof r.ts === 'string' ? Date.parse(r.ts) : Number.NaN;
    return Number.isFinite(t) && t >= since;
  });
  const ms = recs.map((r) => r.ms).filter((m): m is number => typeof m === 'number' && m >= 0);
  const errors = recs.filter((r) => r.ok === false).length;
  const failures = recs.filter((r) => typeof r.error === 'string').length;
  const calls = `${recs.length} ${recs.length === 1 ? 'call' : 'calls'}`;
  return {
    name: 'recent calls',
    ok: true,
    detail: recs.length
      ? `${calls} in the last 24 h: p50 ${percentile(ms, 50)} ms, p95 ${percentile(ms, 95)} ms, ` +
        `${errors} ${errors === 1 ? 'error' : 'errors'} (${failures} not the command's own)`
      : `${calls} in the last 24 h`,
  };
}

/**
 * Every check, in order. A check that cannot run (no login, no live sandbox) is left out, as the
 * one before it already failed and says why; the local ones (the agent configuration, the flight
 * recorder) always run.
 */
export async function runDoctor(
  c: SbxCtx,
  /** The repository root, or undefined outside one: the agent configuration is then not checked. */
  root: string | undefined,
  id: string | undefined,
  factory?: ExecFactory,
  /** `claude --version`'s output (default: asked of the `claude` on PATH); tests pass their own. */
  claudeVersion: () => Promise<string | undefined> | string | undefined = installedClaudeVersion,
  agentop: AgentopExec = runAgentop,
): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const login = await loginCheck(c);
  out.push(login);
  let live = false;
  /** The sandbox's mode, from its record: the rules block must be that mode's. */
  let mode: SandboxModeName | undefined;
  if (!id) {
    out.push({
      name: 'sandbox',
      ok: false,
      detail: 'no sandbox is bound here (no .sbx/sandbox.json)',
      fix: `${UP} in the repository, or mocactl sbx doctor --sandbox ID`,
    });
  } else if (login.ok) {
    const s = await sandboxCheck(c, id);
    out.push(s.check);
    live = s.live;
    mode = s.mode;
  }
  if (root !== undefined) {
    out.push(configCheck(root, mode));
    if (cortexMode(root)) out.push(await cortexCheck(agentop));
    const old = claudeVersionCheck(await claudeVersion());
    if (old) out.push(old);
  }
  if (id && live) out.push(...(await execChecks(c, id, factory)));
  if (id) out.push(recorderCheck(c, id));
  return out;
}

/** `mocactl sbx doctor`: exit 0 when every check passes, else 1. */
export async function cmdDoctor(
  c: SbxCtx,
  root: string | undefined,
  id: string | undefined,
  factory?: ExecFactory,
  claudeVersion?: () => Promise<string | undefined> | string | undefined,
  agentop?: AgentopExec,
): Promise<number> {
  const checks = await runDoctor(c, root, id, factory, claudeVersion, agentop);
  const ok = checks.every((k) => k.ok);
  const clean = (k: DoctorCheck): DoctorCheck => ({
    ...k,
    detail: sanitizeRemote(k.detail),
    ...(k.fix !== undefined ? { fix: sanitizeRemote(k.fix) } : {}),
  });
  if (c.json) {
    c.io.out(JSON.stringify({ ok, checks: checks.map(clean) }) + '\n');
  } else {
    for (const k of checks.map(clean)) {
      const tag = !k.ok ? 'FAIL' : k.warn ? 'warn' : 'ok';
      c.io.out(`${tag} - ${k.name}: ${k.detail}${k.fix ? ` (fix: ${k.fix})` : ''}\n`);
    }
  }
  return ok ? SBX_EXIT.ok : SBX_EXIT.failed;
}
