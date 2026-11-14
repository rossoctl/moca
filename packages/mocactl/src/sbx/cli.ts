import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MAX_STDIN_BYTES, q, WORKSPACE, type SandboxModeName } from '@moca/sandbox-client';
import {
  loadConfig,
  normalizeUrl,
  resolvePaths,
  storedLoginUrl,
  type Paths,
  type TuiConfig,
} from '../config.js';
import { sanitizeRemote } from '../core/sanitize.js';
import type { Io, LoginHelpers } from '../headless.js';
import { buildRuntime, ensureRuntimeAuth, type Runtime } from '../runtime.js';
import { SandboxApiClient, type SbxSandboxCreate } from './api.js';
import {
  cmdCreate,
  cmdEditTemplate,
  cmdEgress,
  cmdEnv,
  cmdLogin,
  cmdLogout,
  cmdLs,
  cmdRm,
  cmdTagTemplate,
  cmdTemplates,
  cmdToken,
  cmdTransferTemplate,
  cmdUntagTemplate,
  failRefresh,
  SBX_EXIT,
  type SbxCtx,
} from './commands.js';
import { cmdDoctor } from './doctor.js';
import { type ExecFactory } from './exec.js';
import { cmdCodex, type CodexDeps } from './codex.js';
import { cmdClaude, type ClaudeDeps } from './claude.js';
import {
  addCredential,
  addProblem,
  deleteCredential,
  listCredentials,
  listPresets,
} from './credentials.js';
import {
  busyRetries,
  cmdMcp,
  cmdPut,
  cmdRun,
  parseTimeout,
  workspacePath,
  type RunRetry,
} from './run.js';
import { PushError, repoRoot } from './push.js';
import { findSandboxFile, readBinding, readBoundSandbox, SANDBOX_ID_RE } from './state.js';
import { checkBeforeRm, cmdPull, cmdPush, cmdUp, DEFAULT_TEMPLATE, unbind } from './sync.js';
import { type AgentopExec } from './agentop.js';
import { openCallRecord, type CallRecorder } from './call-record.js';
import {
  cmdActivate,
  cmdCancelBuild,
  cmdCreateTemplates,
  cmdDeactivate,
  cmdDryRun,
  cmdFollowTemplate,
  cmdHosts,
  cmdPolicy,
  cmdQuota,
  cmdRetire,
  cmdShowTemplate,
  readCreateInputs,
} from './templates.js';
import { cortexMode } from './agent-config.js';
import { isModeName, MODE_NAMES, modeRank, UPGRADE_NEEDS_TTY } from './mode.js';
import { cmdGet, cmdMode, cmdReset } from './lease-commands.js';

export const SBX_USAGE = `usage (the sandbox service, SBX0):
  mocactl sbx login [--control-plane-url URL] [--no-browser]
                                                 log in with the GitHub device flow (the URL is remembered;
                                                 in a local terminal: copies the code, opens the browser)
  mocactl sbx logout                             end the sandbox-service login (deletes sbx-auth.json)
  mocactl sbx templates [--json]                 the templates a sandbox can be created from, with
                                                 their readiness and tags
  mocactl sbx quota [--json]                     your template quotas and use, and your live-sandbox cap
  mocactl sbx policy [--json]                    the deployment's template policy: profiles (envelope,
                                                 egress, rules), allowed registries, quotas, digest
  mocactl sbx templates create --spec F [--spec F ...] [--id ID] [--image REF] [--profile P]
                               [--visibility private|deployment] [--gate-record F] [--dry-run]
                               [--timeout S] [--json]
                                                 create a template (or a new build of your own) from a
                                                 spec, or from a gate record's template block; id and
                                                 image default to the spec's; the gate record (one
                                                 --spec, at most 1 MiB) is sent byte for byte.
                                                 Several --spec: one create each, waiting
                                                 for a queue slot while your buildsQueued quota is full
                                                 (up to S, default 3600). An id already yours: a new
                                                 build of it (the same inputs: that build, reused).
                                                 --dry-run: reads the policy, then its checks that
                                                 need only the inputs; nothing created
  mocactl sbx templates build ID --spec F [--image REF] [--profile P] [--gate-record F] [--dry-run]
                               [--timeout S] [--json]
                                                 a new build of your template ID
  mocactl sbx templates show ID [--build BUILD] [--json]
                                                 a template and its builds (status, readiness, tags,
                                                 why a build failed), or one build with its spec (--json)
  mocactl sbx templates follow ID [--build BUILD] [--timeout S] [--json]
                                                 poll a build (default: the newest) until registered,
                                                 failed, rejected or cancelled; exit 0 only on
                                                 registered, 1 on any other end, 5 past S (default
                                                 3600), 130 on Ctrl-C (the build goes on)
  mocactl sbx templates cancel ID --build BUILD [--json]
                                                 withdraw a queued, building or probing build
  mocactl sbx templates tag ID TAG... --build BUILD [--json]
                                                 move tags onto a registered build of a template you
                                                 own; sandboxes made earlier keep their build
  mocactl sbx templates untag ID TAG [--json]    remove a tag; its build stays (never default)
  mocactl sbx templates edit ID [--visibility private|deployment] [--description TEXT] [--json]
                                                 change who sees it, or its description
  mocactl sbx templates transfer ID SUBJECT [--json]
                                                 make SUBJECT (github:<id> or oidc:<sub>) its owner
                                                 (admins only)
  mocactl sbx templates activate ID [--build BUILD] [--lease S] [--wait [--timeout S]] [--json]
                                                 take or renew your activation lease on a build (tag
                                                 default, or BUILD; S seconds, 60-86400); a host agent
                                                 starts its worker. --wait: until it is active, saying
                                                 why it waits (queued at N, no slot, memory); default
                                                 1800 s, raised from the host's start line when queued
                                                 (at most 4 h); exit 5 on a timeout
  mocactl sbx templates deactivate ID [--stop-now] [--json]
                                                 release your leases on a template; with none left,
                                                 its worker drains and stops (after the host's idle
                                                 grace, if it has one; --stop-now skips the grace)
  mocactl sbx templates retire ID [--build BUILD] [--reason TEXT] [--wait [--timeout S]] [--json]
                                                 retire a template you own (every build), or one
                                                 build: never served again, refused while a sandbox
                                                 runs on it, not undone (a new build is the way
                                                 back). --reason: kept in its record (not with
                                                 --build). --wait: until its worker has stopped
                                                 (default 300 s; exit 5 on a timeout), at once for
                                                 a build no host holds, or one whose worker a
                                                 build not retired uses; waiting for
                                                 its removal from every host comes with #743
  mocactl sbx hosts [--json]                     per KVM host: active slots, start line, memory
                                                 headroom and floor, idle grace, disk
  mocactl sbx create [--template ID[:TAG|@BUILD]] [--name N] [--label k=v ...] [--seed]
                     [--mode per-exec|lease|lease+processes] [--idle-timeout S] [--json]
                                                 create a sandbox (template: default); prints its id;
                                                 --seed: run the served build's seed, then check
                                                 /workspace is a clean tree (its HEAD becomes the
                                                 baseline pull and rm measure changes from);
                                                 --mode (default per-exec): a lease mode keeps the
                                                 guest between commands (the deployment must allow
                                                 it; an upgrade, so only from a terminal), its
                                                 lease ending after S idle seconds (default: the
                                                 worker's)
  mocactl sbx ls [--all] [--json]                your sandboxes (--all: everyone's; admins only)
  mocactl sbx get [ID] [--json]                  a sandbox's mode, epoch and idle timeout, and its
                                                 lease's state (a lease mode the worker has not
                                                 taken yet is sent again)
  mocactl sbx mode per-exec|lease|lease+processes [ID] [--idle-timeout S]
                                                 change the sandbox's mode (an upgrade only from a
                                                 terminal; the idle timeout is kept unless given); a
                                                 worker that cannot be reached takes it at the next
                                                 command; a downgrade ends the lease
  mocactl sbx reset [ID]                         end the sandbox's lease: the next command starts a
                                                 new guest (/tmp, installs outside /workspace and
                                                 background processes are gone)
  mocactl sbx rm [ID] [--keep-config] [--force] [--json]
                                                 delete a sandbox (its lease ended first); for the
                                                 bound one, also take back the agent configuration
                                                 sbx up added, and .sbx/ (unless --keep-config)
                                                 (refused while the sandbox has changes not yet
                                                 pulled, unless --force, or when that cannot be
                                                 checked)
  mocactl sbx token [ID] [--renew-every S] [--json]
                                                 print a fresh sandbox token (15 minutes by default);
                                                 --renew-every: a new line every S seconds until stopped
  mocactl sbx env [ID]                           shell exports for a direct sandbox/v1 client
  mocactl sbx egress [ID] [--json | --ndjson | --verify]
                                                 what the sandbox reached through its host's egress
                                                 proxy: per host, and whether the log is complete;
                                                 --ndjson prints the log whose sha256 its end record names;
                                                 --verify checks the log served against the control
                                                 plane's summary of it (sha256 and count; once the log
                                                 is sealed, 10 minutes after the end, it is final)
  mocactl sbx run [--sandbox ID] [--timeout S] [-- CMD ...]   run CMD (or the script on stdin) in /workspace
                                                 (CMD's words are quoted, so they run exactly as typed:
                                                 for pipes, $VARS or globs use stdin or -- sh -c '...';
                                                 exit: the command's code; 124 timed out or killed;
                                                 125 sandbox failure; 75 refused before it started,
                                                 every try (retried MOCACTL_SBX_BUSY_RETRIES times,
                                                 default 4, at most 20; nothing ran); 130
                                                 interrupted; S defaults to, and is capped at, the
                                                 sandbox token's lifetime minus 60 s)
  mocactl sbx put PATH [--sandbox ID]            write stdin to PATH under /workspace
                                                 (a refusal before start: retried, 75, as run's)
  mocactl sbx mcp [--sandbox ID]                 the stdio MCP server for Claude Code / OpenCode
  mocactl sbx claude [-- CLAUDE_ARGS ...]        run Claude Code on this sandbox's MCP tools, for
                                                 one run (--mcp-config + --strict-mcp-config,
                                                 nothing written, no approval asked: the first
                                                 bare claude session's approval question is why
                                                 this exists, #577; Claude Code still asks once
                                                 whether you trust the folder. The session loads
                                                 no MCP server but the sandbox's; run claude
                                                 yourself for your own servers). Its local tools
                                                 are denied (--disallowed-tools) from any
                                                 directory, except in a repo up --cortex set up,
                                                 where Cortex blocks them
  mocactl sbx codex [-- CODEX_ARGS ...]          run Codex CLI on this sandbox's MCP tools, for one
                                                 run (-c, nothing written: Codex reads no
                                                 project-local config, so up cannot configure it).
                                                 Its shell tool is off, but unified_exec cannot be
                                                 disabled, so local execution is restricted, not
                                                 denied: use Codex's own sandbox_mode as well
  mocactl sbx up [--template T] [--name N] [--include-secrets] [--max-push MiB] [--no-agent-config] [--cortex]
                                                 in a git repository: create or reuse its sandbox,
                                                 push the working tree, bind it in .sbx/sandbox.json,
                                                 and point Claude Code, OpenCode and IBM Bob at the
                                                 sandbox's MCP tools, with their local tools denied
                                                 (Bob's cannot be: it has no deny list) (merged
                                                 into .mcp.json, .claude/settings.json,
                                                 opencode.json, .bob/settings.json, .bob/mcp.json,
                                                 CLAUDE.md, AGENTS.md; a value there that conflicts
                                                 stops up before anything is done)
                                                 (a reused sandbox with changes not yet pulled is
                                                 left unpushed, with a warning, and up exits 0)
                                                 (--cortex: Cortex v0.9.3+ blocks the local tools
                                                 instead of a deny list, so Claude Code loads the
                                                 project's CLAUDE.md; kept by later runs)
  mocactl sbx push [--force] [--include-secrets] [--max-push MiB]   push the working tree again
                                                 (refused while the sandbox has changes not yet
                                                 pulled, unless --force; .env*, *.pem, *.key and
                                                 id_* stay behind unless --include-secrets)
  mocactl sbx pull [--apply] [-o FILE]           the sandbox's changes as a patch, on stdout or in
                                                 FILE (--apply: apply it here, then advance the
                                                 sandbox's baseline)
  mocactl sbx credentials [list] [--json]       the credentials the host swaps into your sandboxes' HTTPS requests
  mocactl sbx credentials add NAME (--host DEST ... [--kind K] | --preset ID)
                                                 store one (the secret is read from stdin, never argv);
                                                 DEST is host[:port][/prefix]; K: bearer (default), basic,
                                                 api-key, oauth2-token (basic: stdin is username=...
                                                 and password=... lines)
  mocactl sbx credentials presets [--json]       the presets \`add --preset\` knows
  mocactl sbx credentials delete NAME            delete one
  mocactl sbx doctor [--sandbox ID] [--json]     check login, sandbox, agent config, exec and recent
                                                 calls (exit 0 when every check passes, else 1)
--record F (every command that calls the API but token, login, logout and credentials): one
NDJSON line per HTTP attempt appended to F (0600), with no token, host or free text in it.
ID (or --sandbox ID) defaults to the sandbox in the nearest .sbx/sandbox.json. The control plane
comes from --control-plane-url, MOCACTL_SBX_URL, the bound sandbox's, the one remembered at
login, or the login's own (a login minted by an operator). The login is kept apart from \`mocactl login\`'s, so both can be active at once.
exit: 0 ok, 1 failed, 2 usage, 3 log in first, 4 control plane unreachable, 5 a wait timed out,
130 interrupted (Ctrl-C)`;

export interface SbxDeps {
  signal?: AbortSignal;
  home?: string;
  fetchImpl?: typeof fetch;
  cwd?: string;
  /** Whether stdin is a terminal: `run` with no command then refuses rather than wait on it. */
  stdinIsTTY?: boolean;
  /** All of stdin as text: `run`'s script. */
  readStdin?: () => Promise<string>;
  /** All of stdin, byte for byte: `put`'s content. */
  readStdinBytes?: (limit?: number) => Promise<Buffer>;
  /** The gRPC connection (tests pass a fake). */
  execFactory?: ExecFactory;
  /**
   * The template commands' and `token --renew-every`'s waits, and `run`'s wait between tries
   * after a refusal before start (default: the runtime's sleep).
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** `run`'s jitter, 0 to 1 (default Math.random). */
  random?: () => number;
  /** The template commands' and `--record`'s clock, epoch ms (default: the runtime's). */
  now?: () => number;
  /** `doctor`'s `claude --version` (default: asked of the `claude` on PATH). */
  claudeVersion?: () => Promise<string | undefined> | string | undefined;
  /** Cortex's agentop, for `up --cortex` and `doctor` in Cortex mode (default: the one on PATH). */
  agentop?: AgentopExec;
  /** `mcp`'s transport (default stdio). */
  mcpTransport?: Transport;
  /** `codex`'s child process (default: the `codex` on PATH). */
  codex?: CodexDeps;
  /** `claude`'s child process (default: the `claude` on PATH). */
  claude?: ClaudeDeps;
  /** `login`'s clipboard and browser; absent when nobody is at this machine's screen. */
  loginHelpers?: LoginHelpers;
}

export function resolveSbxUrl(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  config: TuiConfig,
  login?: string,
): string | undefined {
  return normalizeUrl(flag || env.MOCACTL_SBX_URL || config.sbxControlPlaneUrl || login);
}

/**
 * The control plane the sandbox-service login itself names (`sbx-auth.json`'s `controlPlaneUrl`):
 * the last fallback, for a login file present without `sbx login`'s config.json entry (one copied
 * from another machine, say), since `sbx login` also remembers its URL in config.json.
 */
export function loginControlPlaneUrl(env: NodeJS.ProcessEnv, home: string): string | undefined {
  const u = storedLoginUrl(sbxPaths(resolvePaths(env, home)).authFile);
  return u && /^https?:\/\//.test(u) ? u : undefined;
}

/** Where resolveSbxUrl's answer came from, by the same precedence (and the same `||`). */
export function sbxUrlSource(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  config: TuiConfig,
  login?: string,
): 'flag' | 'env' | 'config' | 'login' | undefined {
  if (flag) return 'flag';
  if (env.MOCACTL_SBX_URL) return 'env';
  if (config.sbxControlPlaneUrl) return 'config';
  return login ? 'login' : undefined;
}

/**
 * mocactl's paths with the login moved to `sbx-auth.json` beside `auth.json`. auth.json holds ONE
 * login, so sharing it would make `mocactl sbx login` log the user out of MOCA; a file of its own
 * also gives the sbx login its own refresh lock (`authLockPath`).
 */
export function sbxPaths(paths: Paths): Paths {
  return { ...paths, authFile: join(paths.configDir, 'sbx-auth.json') };
}

/**
 * A runtime on the SANDBOX control plane: its own URL, its own login file, and no harness (neither
 * SH_HARNESS_URL nor config.harnessUrl is read). Its control-plane client IS the SandboxApiClient,
 * so the runtime's refresh-and-retry wiring (and `rt.lastRefreshFailure`) covers every sbx call.
 */
export function openSbxRuntime(
  url: string,
  env: NodeJS.ProcessEnv,
  deps: SbxDeps,
): { rt: Runtime; api: SandboxApiClient } {
  let api: SandboxApiClient | undefined;
  const rt = buildRuntime({ controlPlaneUrl: url }, env, deps.home, deps.fetchImpl, {
    paths: sbxPaths,
    harness: false,
    client: (...a) => (api = new SandboxApiClient(...a)),
  });
  // `url` is never empty here, so the runtime always built its client through the factory.
  return { rt, api: api! };
}

/** `run`'s and `put`'s retry after a refusal before start. */
function runRetry(env: NodeJS.ProcessEnv, deps: SbxDeps, ctx: SbxCtx): RunRetry {
  return {
    retries: busyRetries(env),
    sleep: deps.sleep ?? ctx.rt.sleep,
    ...(deps.random ? { random: deps.random } : {}),
  };
}

/**
 * The sandbox runtime and client, logged in: or the exit code to stop with. A refresh the control
 * plane refused for a reason of its own (a 403 `not_enrolled` for a user removed since login) is a
 * failure with its message; only a network failure is "unreachable".
 */
export async function openSbx(
  flags: { controlPlaneUrl?: string },
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: SbxDeps,
  opts: {
    login?: boolean;
    /** Where a `flags.controlPlaneUrl` came from, when not a flag. */ urlFrom?: string;
  } = {},
): Promise<{ rt: Runtime; api: SandboxApiClient; url: string; explicitUrl?: string } | number> {
  const remembered = loadConfig(resolvePaths(env, deps.home ?? homedir())).config;
  const fromLogin = loginControlPlaneUrl(env, deps.home ?? homedir());
  const url = resolveSbxUrl(flags.controlPlaneUrl, env, remembered, fromLogin);
  if (!url) {
    io.err('sbx: no sandbox control plane: pass --control-plane-url URL, or set MOCACTL_SBX_URL');
    return SBX_EXIT.usage;
  }
  const source = sbxUrlSource(flags.controlPlaneUrl, env, remembered, fromLogin);
  const explicitUrl = source === 'config' || source === 'login' ? undefined : url;
  const opened = {
    ...openSbxRuntime(url, env, deps),
    url,
    ...(explicitUrl ? { explicitUrl } : {}),
  };
  const { rt } = opened;
  if (opts.login) return opened;
  const auth = await ensureRuntimeAuth(rt);
  if (auth.kind === 'login_required') {
    // A URL from a flag (or a bound sandbox's) is not what a bare `sbx login` would use: name it.
    const login =
      sbxUrlSource(flags.controlPlaneUrl, env, remembered) === 'flag'
        ? `mocactl sbx login --control-plane-url ${q(sanitizeRemote(url))}`
        : 'mocactl sbx login';
    const where = opts.urlFrom ? ` at ${sanitizeRemote(url)} (from ${opts.urlFrom})` : '';
    // A binding naming another control plane than the one remembered: logging in there would hand
    // it this working tree on the next push. Say so, rather than only nudge a login (#554 review).
    const other =
      opts.urlFrom &&
      remembered.sbxControlPlaneUrl &&
      normalizeUrl(remembered.sbxControlPlaneUrl) !== normalizeUrl(url)
        ? `; that is not the control plane you logged in to (${sanitizeRemote(remembered.sbxControlPlaneUrl)}): log in there only if you trust it, as it would receive this repository's files`
        : '';
    io.err(`sbx: not logged in to the sandbox service${where}: run \`${login}\`${other}`);
    return SBX_EXIT.loginRequired;
  }
  if (auth.kind === 'unreachable') return failRefresh(io, auth.error);
  return opened;
}

/** The commands with no --json output (R5i): refused with exit 2 rather than ignored. */
const NO_JSON = new Set([
  'login',
  'logout',
  'env',
  'run',
  'put',
  'mcp',
  'claude',
  'codex',
  'up',
  'push',
  'pull',
  'mode',
  'reset',
]);
/** The commands that open without the login check: they log in, out, or check it themselves (R7). */
const OWN_LOGIN = new Set(['login', 'logout', 'doctor']);
/**
 * The commands `--record F` is refused on: a token printed on purpose, the login itself, and
 * credentials, whose secrets are the request.
 */
const NO_RECORD = new Set(['token', 'login', 'logout', 'credentials']);
/** The `templates` owner's and admin's subcommands (lifecycle spec §5.1-§5.2). */
const TEMPLATE_ADMIN_SUBS = ['tag', 'untag', 'edit', 'transfer'];
/** The `templates` subcommands; their arguments are checked one by one in sbxMain. */
const TEMPLATE_SUBS = [
  'create',
  'build',
  'show',
  'follow',
  'cancel',
  ...TEMPLATE_ADMIN_SUBS,
  'activate',
  'deactivate',
  'retire',
];
/** The `templates` subcommands that take one template ID. */
const TEMPLATE_ONE_ID = [
  'build',
  'show',
  'follow',
  'cancel',
  'edit',
  'activate',
  'deactivate',
  'retire',
];
/** The `templates` subcommands that take --build, and those that take --timeout (a wait; activate's
 * and retire's only with --wait). */
const TAKES_BUILD = ['show', 'follow', 'cancel', 'tag', 'activate', 'retire'];
const TAKES_TIMEOUT = ['follow', 'create', 'build', 'activate', 'retire'];
/** The commands that act on one sandbox: `[ID]` as an argument (or `--sandbox ID`). */
const TAKES_ID_ARG = new Set(['rm', 'token', 'env', 'get', 'reset', 'egress']);
/** The commands that act on one sandbox through `--sandbox ID` only. */
const TAKES_SANDBOX_FLAG = new Set([
  'run',
  'put',
  'mcp',
  'claude',
  'codex',
  'push',
  'pull',
  'doctor',
  'mode',
  ...TAKES_ID_ARG,
]);
/** The commands that work on the git repository around the current directory. */
const IN_REPO = new Set(['up', 'push', 'pull', 'doctor']);
/** Flags that belong to some commands only: refused elsewhere rather than silently ignored. */
const SYNC_FLAGS: [
  (
    | 'force'
    | 'include-secrets'
    | 'max-push'
    | 'apply'
    | 'out'
    | 'no-agent-config'
    | 'cortex'
    | 'keep-config'
    | 'no-browser'
    | 'renew-every'
    | 'seed'
    | 'mode'
    | 'idle-timeout'
  ),
  string[],
][] = [
  ['force', ['push', 'rm']],
  ['seed', ['create']],
  ['mode', ['create']],
  ['idle-timeout', ['create', 'mode']],
  ['include-secrets', ['up', 'push']],
  ['max-push', ['up', 'push']],
  ['apply', ['pull']],
  ['out', ['pull']],
  ['no-agent-config', ['up']],
  ['cortex', ['up']],
  ['keep-config', ['rm']],
  ['no-browser', ['login']],
  ['renew-every', ['token']],
];

/** A whole number of seconds, at least 1, for `flag`; null (after saying why) when malformed. */
function wholeSeconds(io: Io, flag: string, raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    io.err(`sbx: --${flag} must be a whole number of seconds, at least 1 (got '${raw}')`);
    return null;
  }
  return n;
}
/** `--max-push` in MiB: up to 4 GiB, far above what a push should ever be. */
const MAX_PUSH_MIB = 4096;

const mib = (n: number) => `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) ? 1 : 0)} MiB`;

/**
 * `--idle-timeout S`: a whole number of seconds, at least 1 (the control plane holds the range,
 * 30 to its ceiling). Undefined when absent; null, after saying why, when malformed.
 */
function parseIdleTimeout(io: Io, raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    io.err(`sbx: --idle-timeout must be a whole number of seconds (got '${sanitizeRemote(raw)}')`);
    return null;
  }
  return n;
}

function parseLabels(io: Io, raw: string[]): Record<string, string> | undefined {
  const labels: Record<string, string> = {};
  for (const l of raw) {
    const m = /^([^=]+)=(.*)$/s.exec(l);
    if (!m) {
      io.err(`sbx: --label must be key=value, got '${l}'`);
      return undefined;
    }
    labels[m[1]!] = m[2]!;
  }
  return labels;
}

export async function sbxMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: SbxDeps = {},
): Promise<number> {
  const opened: { recorder?: CallRecorder } = {};
  try {
    return await sbxMainWith(argv, env, io, deps, opened);
  } finally {
    opened.recorder?.close();
  }
}

async function sbxMainWith(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: SbxDeps,
  record: { recorder?: CallRecorder },
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'control-plane-url': { type: 'string' },
        template: { type: 'string' },
        build: { type: 'string' },
        description: { type: 'string' },
        visibility: { type: 'string' },
        seed: { type: 'boolean' },
        mode: { type: 'string' },
        'idle-timeout': { type: 'string' },
        name: { type: 'string' },
        label: { type: 'string', multiple: true },
        all: { type: 'boolean' },
        json: { type: 'boolean' },
        ndjson: { type: 'boolean' },
        verify: { type: 'boolean' },
        sandbox: { type: 'string' },
        timeout: { type: 'string' },
        lease: { type: 'string' },
        wait: { type: 'boolean' },
        reason: { type: 'string' },
        'stop-now': { type: 'boolean' },
        force: { type: 'boolean' },
        'include-secrets': { type: 'boolean' },
        'max-push': { type: 'string' },
        apply: { type: 'boolean' },
        out: { type: 'string', short: 'o' },
        'no-agent-config': { type: 'boolean' },
        cortex: { type: 'boolean' },
        'keep-config': { type: 'boolean' },
        'no-browser': { type: 'boolean' },
        host: { type: 'string', multiple: true },
        kind: { type: 'string' },
        preset: { type: 'string' },
        'renew-every': { type: 'string' },
        record: { type: 'string' },
        spec: { type: 'string', multiple: true },
        id: { type: 'string' },
        image: { type: 'string' },
        profile: { type: 'string' },
        'gate-record': { type: 'string' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  const { values, positionals } = parsed;
  const [command, arg, ...extra] = positionals;
  if (values.help) {
    io.out(SBX_USAGE + '\n');
    return SBX_EXIT.ok;
  }
  if (!command) {
    io.err(SBX_USAGE);
    return SBX_EXIT.usage;
  }
  const known = [
    'login',
    'logout',
    'templates',
    'hosts',
    'create',
    'ls',
    'rm',
    'token',
    'env',
    'run',
    'put',
    'mcp',
    'claude',
    'codex',
    'up',
    'push',
    'pull',
    'doctor',
    'credentials',
    'egress',
    'quota',
    'policy',
    'get',
    'mode',
    'reset',
  ];
  if (!known.includes(command)) {
    io.err(`sbx: unknown command '${command}'\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  // These print no JSON (login and logout report on stderr, env prints shell exports), so a
  // --json would be silently ignored: refuse it rather than hand a script something it cannot parse.
  if (values.json && NO_JSON.has(command)) {
    io.err(`sbx: ${command} has no --json output\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.sandbox !== undefined && !TAKES_SANDBOX_FLAG.has(command)) {
    io.err(`sbx: --sandbox does not apply to ${command}\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if ((values.ndjson || values.verify) && command !== 'egress') {
    io.err(`sbx: --ndjson and --verify only apply to egress\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.ndjson && values.json) {
    io.err(`sbx: egress takes --json or --ndjson, not both\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.verify && values.ndjson) {
    io.err(`sbx: egress takes --ndjson or --verify, not both\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  // `templates SUB`: the template subcommand, for the flags that apply to some of them only.
  const sub = command === 'templates' ? arg : undefined;
  const activating = sub === 'activate';
  const retiring = sub === 'retire';
  if (
    values.timeout !== undefined &&
    command !== 'run' &&
    !(sub !== undefined && TAKES_TIMEOUT.includes(sub))
  ) {
    io.err(
      `sbx: --timeout only applies to run and templates ${TAKES_TIMEOUT.join(', ')}\n${SBX_USAGE}`,
    );
    return SBX_EXIT.usage;
  }
  const createFlag = (['spec', 'image', 'profile', 'gate-record', 'dry-run'] as const).find(
    (f) => values[f] !== undefined,
  );
  if (createFlag && !(sub === 'create' || sub === 'build')) {
    io.err(`sbx: --${createFlag} only applies to templates create and build\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.timeout !== undefined && (activating || retiring) && !values.wait) {
    io.err(`sbx: --timeout with templates ${sub} needs --wait\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.id !== undefined && sub !== 'create') {
    io.err(`sbx: --id only applies to templates create\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.visibility !== undefined && !(sub === 'create' || sub === 'edit')) {
    io.err(`sbx: --visibility only applies to templates create and edit\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if ((sub === 'create' || sub === 'build') && !values.spec?.length) {
    io.err(`sbx: templates ${sub} needs --spec F\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (sub === 'build' && (values.spec?.length ?? 0) > 1) {
    io.err(`sbx: templates build takes one --spec\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.lease !== undefined && !activating) {
    io.err(`sbx: --lease only applies to templates activate\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.wait !== undefined && !(activating || retiring)) {
    io.err(`sbx: --wait only applies to templates activate and templates retire\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.reason !== undefined && !retiring) {
    io.err(`sbx: --reason only applies to templates retire\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.reason !== undefined && values.build !== undefined) {
    io.err(
      `sbx: --reason is kept for a whole template's retire; retiring one build (--build) takes none\n${SBX_USAGE}`,
    );
    return SBX_EXIT.usage;
  }
  if (values['stop-now'] !== undefined && !(command === 'templates' && arg === 'deactivate')) {
    io.err(`sbx: --stop-now only applies to templates deactivate\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  let leaseSeconds: number | undefined;
  if (values.lease !== undefined) {
    const raw = values.lease.trim();
    leaseSeconds = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 86_400) {
      io.err(`sbx: --lease must be a whole number of seconds, 60 to 86400 (got '${values.lease}')`);
      return SBX_EXIT.usage;
    }
  }
  const flagMisuse = SYNC_FLAGS.find(
    ([flag, cmds]) => values[flag] !== undefined && !cmds.includes(command),
  );
  if (flagMisuse) {
    io.err(`sbx: --${flagMisuse[0]} only applies to ${flagMisuse[1].join(' and ')}\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.record !== undefined && NO_RECORD.has(command)) {
    io.err(`sbx: ${command} takes no --record (it would record a secret)\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  const renewEvery = wholeSeconds(io, 'renew-every', values['renew-every']);
  if (renewEvery === null) return SBX_EXIT.usage;
  const credFlag = (['host', 'kind', 'preset'] as const).find((f) => values[f] !== undefined);
  if (credFlag && !(command === 'credentials' && arg === 'add')) {
    io.err(`sbx: --${credFlag} only applies to credentials add\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.cortex && values['no-agent-config']) {
    io.err(
      `sbx: --cortex is a choice about the agent configuration, which --no-agent-config does not write\n${SBX_USAGE}`,
    );
    return SBX_EXIT.usage;
  }
  if (values.template !== undefined && !values.template.trim()) {
    io.err(`sbx: --template needs a template id (see mocactl sbx templates)\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (
    (values.template !== undefined || values.name !== undefined) &&
    !['create', 'up'].includes(command)
  ) {
    io.err(`sbx: --template and --name only apply to create and up\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  // `templates SUB ...` (template lifecycle spec §4), the owner's and admin's actions (§5.1-§5.2,
  // retire among them), and activate and deactivate (§6.3); bare `templates` lists them.
  if (sub !== undefined && !TEMPLATE_SUBS.includes(sub)) {
    io.err(`sbx: unknown templates command '${sanitizeRemote(sub)}'\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (sub !== undefined && TEMPLATE_ADMIN_SUBS.includes(sub) && extra.some((x) => !x.trim())) {
    io.err(`sbx: templates ${sub} takes no empty argument\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (sub === 'create' && extra.length > 0) {
    io.err(`sbx: templates create takes no ID (the spec names it, or --id)\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (
    sub !== undefined &&
    TEMPLATE_ONE_ID.includes(sub) &&
    (extra.length !== 1 || !extra[0]!.trim())
  ) {
    io.err(`sbx: templates ${sub} takes one template ID\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if ((sub === 'untag' || sub === 'transfer') && extra.length !== 2) {
    io.err(
      `sbx: templates ${sub} takes a template ID and ${sub === 'untag' ? 'a TAG' : 'a SUBJECT'}\n${SBX_USAGE}`,
    );
    return SBX_EXIT.usage;
  }
  if (sub === 'tag' && extra.length < 2) {
    io.err(`sbx: templates tag takes a template ID and at least one TAG\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.build !== undefined && !(sub !== undefined && TAKES_BUILD.includes(sub))) {
    io.err(`sbx: --build only applies to templates ${TAKES_BUILD.join(', ')}\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (sub === 'cancel' && values.build === undefined) {
    io.err(`sbx: templates cancel needs --build BUILD\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (sub === 'tag' && values.build === undefined) {
    io.err(`sbx: templates tag needs --build BUILD\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.description !== undefined && sub !== 'edit') {
    io.err(`sbx: --description only applies to templates edit\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (sub === 'edit' && values.visibility === undefined && values.description === undefined) {
    io.err(`sbx: templates edit needs --visibility or --description\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (
    sub === 'edit' &&
    values.visibility !== undefined &&
    values.visibility !== 'private' &&
    values.visibility !== 'deployment'
  ) {
    io.err(`sbx: --visibility must be private or deployment\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  if (values.build !== undefined && !values.build.trim()) {
    io.err(`sbx: --build needs a build id (see mocactl sbx templates show ID)\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  let maxPush: number | undefined;
  if (values['max-push'] !== undefined) {
    const raw = values['max-push'].trim();
    const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PUSH_MIB) {
      io.err(
        `sbx: --max-push must be a whole number of MiB, 1 to ${MAX_PUSH_MIB} (got '${values['max-push']}')`,
      );
      return SBX_EXIT.usage;
    }
    maxPush = n * 2 ** 20;
  }
  // `run` takes everything after the command (after `--`) as CMD; `put` exactly one PATH; rm, token,
  // env and egress at most one ID; every other command no argument at all.
  const argsOk =
    // run quotes its CMD; claude and codex forward their own flags and prompt to the child.
    command === 'run' ||
    (command === 'templates' && arg !== undefined) ||
    command === 'claude' ||
    command === 'codex' ||
    (command === 'credentials'
      ? arg === undefined ||
        (arg === 'presets'
          ? extra.length === 0
          : arg === 'list'
            ? extra.length === 0
            : ['add', 'delete'].includes(arg) && extra.length === 1)
      : command === 'put'
        ? arg !== undefined && extra.length === 0
        : command === 'mode'
          ? extra.length <= 1
          : extra.length === 0 && (arg === undefined || TAKES_ID_ARG.has(command)));
  if (!argsOk) {
    io.err(
      `sbx: ${command === 'put' ? 'put takes exactly one PATH' : `too many arguments for ${command}`}\n${SBX_USAGE}`,
    );
    return SBX_EXIT.usage;
  }

  // Everything checkable locally is checked before a request (or a refresh) is made. Every id is
  // checked, whether it came from an argument, --sandbox or .sbx/sandbox.json: it goes into URLs
  // and the flight recorder's file name.
  let root: string | undefined;
  // What `up`/`push` were run from, so the plan can say when that is not the work-tree root (#611).
  const cwd = deps.cwd ?? process.cwd();
  if (IN_REPO.has(command) && !(command === 'pull' && !values.apply && values.sandbox)) {
    try {
      root = await repoRoot(cwd);
    } catch (err) {
      if (!(err instanceof PushError)) throw err;
      // doctor with --sandbox has checks that need no repository: it runs them, and says so.
      if (command === 'doctor' && values.sandbox !== undefined) {
        io.err('sbx: not in a git repository: the agent configuration is not checked');
      } else {
        io.err(`sbx: ${err.message}`);
        return SBX_EXIT.usage;
      }
    }
  }
  let id: string | undefined;
  let boundUrl: string | undefined;
  let upBound: string | undefined;
  if (command === 'up') {
    const bound = readBinding(root!);
    boundUrl = bound?.controlPlaneUrl;
    if (bound && !SANDBOX_ID_RE.test(bound.id)) {
      io.err(`sbx: ignoring .sbx/sandbox.json: '${sanitizeRemote(bound.id)}' is not a sandbox id`);
    } else upBound = bound?.id;
  }
  // `mode MODE [ID]`: the mode is checked before anything else is looked at.
  if (command === 'mode') {
    if (arg === undefined) {
      io.err(
        `sbx: mode needs a mode: ${MODE_NAMES.slice(0, -1).join(', ')} or ${MODE_NAMES.at(-1)}`,
      );
      return SBX_EXIT.usage;
    }
    if (!isModeName(arg)) {
      io.err(
        `sbx: the mode must be one of ${MODE_NAMES.join(', ')} (got '${sanitizeRemote(arg)}')`,
      );
      return SBX_EXIT.usage;
    }
  }
  // `[ID]` as an argument: the one after the command, or after `mode`'s MODE.
  const idArg = command === 'mode' ? extra[0] : TAKES_ID_ARG.has(command) ? arg : undefined;
  if (TAKES_SANDBOX_FLAG.has(command)) {
    id = idArg ?? values.sandbox;
    if (id === undefined) {
      const bound = readBinding(root ?? deps.cwd ?? process.cwd());
      id = bound?.id;
      boundUrl = bound?.controlPlaneUrl;
    }
    // No sandbox is one of doctor's failed checks (it says how to bind one), not a usage error.
    if (!id && command !== 'doctor') {
      io.err(
        TAKES_ID_ARG.has(command) || command === 'mode'
          ? `sbx: ${command} needs a sandbox id (or a .sbx/sandbox.json in this repository)`
          : `sbx: ${command} needs --sandbox ID (or a .sbx/sandbox.json in this repository)`,
      );
      return SBX_EXIT.usage;
    }
    if (id !== undefined && !SANDBOX_ID_RE.test(id)) {
      io.err(`sbx: '${sanitizeRemote(id)}' is not a sandbox id (sbx-…)`);
      return SBX_EXIT.usage;
    }
  }
  const addOpts = (name: string) => ({
    name,
    ...(values.preset !== undefined ? { preset: values.preset } : {}),
    ...(values.kind !== undefined ? { kind: values.kind } : {}),
    hosts: (values.host ?? [])
      .flatMap((h) => h.split(','))
      .map((h) => h.trim())
      .filter(Boolean),
  });
  const modeIdle = command === 'mode' ? parseIdleTimeout(io, values['idle-timeout']) : undefined;
  if (modeIdle === null) return SBX_EXIT.usage;
  const timeoutRaw = parseTimeout(io, values.timeout);
  if (timeoutRaw === null) return SBX_EXIT.usage;
  const timeout: number | undefined = timeoutRaw;
  // A create's files are read before any request: an unreadable spec is a usage error.
  let createInputs: Exclude<ReturnType<typeof readCreateInputs>, string> | undefined;
  if (sub === 'create' || sub === 'build') {
    const read = readCreateInputs(values.spec!, {
      ...(values.id !== undefined ? { id: values.id } : {}),
      // `build ID`: the template is ID; the route ignores the body's id, the checks use ID.
      ...(sub === 'build' ? { id: extra[0]! } : {}),
      ...(values.image !== undefined ? { image: values.image } : {}),
      ...(values.profile !== undefined ? { profile: values.profile } : {}),
      ...(values.visibility !== undefined ? { visibility: values.visibility } : {}),
      ...(values['gate-record'] !== undefined ? { gateRecord: values['gate-record'] } : {}),
    });
    if (typeof read === 'string') {
      io.err(`sbx: ${read}`);
      return SBX_EXIT.usage;
    }
    createInputs = read;
  }
  let script: string | undefined;
  if (command === 'run') {
    // Each word quoted: `run -- grep 'a b' f` runs exactly that, and `$HOME` stays literal. Shell
    // syntax is for a script on stdin, or `-- sh -c '...'`.
    script = positionals.slice(1).map(q).join(' ');
    if (!script) {
      if (deps.stdinIsTTY === true || !deps.readStdin) {
        io.err('sbx: run needs a command (sbx run -- CMD ...), or a script on stdin');
        return SBX_EXIT.usage;
      }
      script = await deps.readStdin();
    }
    if (!script.trim()) {
      io.err('sbx: run needs a command (sbx run -- CMD ...), or a script on stdin');
      return SBX_EXIT.usage;
    }
  }
  let content: Buffer | undefined;
  let target: string | undefined;
  if (command === 'put') {
    target = workspacePath(arg!);
    if (!target) {
      io.err(`sbx: put writes under ${WORKSPACE}; '${arg}' is not under it`);
      return SBX_EXIT.usage;
    }
    if (deps.stdinIsTTY === true || !deps.readStdinBytes) {
      io.err('sbx: put writes its stdin: pipe or redirect the content (sbx put PATH < FILE)');
      return SBX_EXIT.usage;
    }
    // One byte past the cap is enough to refuse: a huge stdin is never held in full.
    content = await deps.readStdinBytes(MAX_STDIN_BYTES + 1);
    if (content.length > MAX_STDIN_BYTES) {
      io.err(
        `sbx: stdin is ${mib(content.length)}, over the ${mib(MAX_STDIN_BYTES)} one Exec can carry; ` +
          'put it in parts, or use `mocactl sbx push`',
      );
      return SBX_EXIT.usage;
    }
  }
  let createBody: SbxSandboxCreate | undefined;
  if (command === 'create') {
    const labels = parseLabels(io, values.label ?? []);
    if (!labels) return SBX_EXIT.usage;
    const mode = values.mode;
    if (mode !== undefined && !isModeName(mode)) {
      io.err(`sbx: --mode must be one of ${MODE_NAMES.join(', ')} (got '${sanitizeRemote(mode)}')`);
      return SBX_EXIT.usage;
    }
    const idle = parseIdleTimeout(io, values['idle-timeout']);
    if (idle === null) return SBX_EXIT.usage;
    // Creating with a lease mode is an upgrade: the user's own act, never an agent's (spec §8.1).
    if (mode !== undefined && modeRank(mode) > 0 && deps.stdinIsTTY !== true) {
      io.err(`sbx: ${UPGRADE_NEEDS_TTY}`);
      return SBX_EXIT.usage;
    }
    createBody = {
      template: values.template ?? DEFAULT_TEMPLATE,
      ...(values.name ? { name: values.name } : {}),
      ...(Object.keys(labels).length ? { labels } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(idle !== undefined ? { idleTimeoutS: idle } : {}),
    };
  }

  if (command === 'credentials') {
    if (arg !== undefined && !['add', 'delete', 'presets', 'list'].includes(arg)) {
      io.err(`sbx: unknown credentials command '${sanitizeRemote(arg)}'\n${SBX_USAGE}`);
      return SBX_EXIT.usage;
    }
    // The catalog is local: no login, no request, no stdin.
    if (arg === 'presets') return listPresets({ io, json: values.json === true });
    if (arg === 'add' || arg === 'delete') {
      if (!extra[0]) {
        io.err(`sbx: credentials ${arg} needs a NAME\n${SBX_USAGE}`);
        return SBX_EXIT.usage;
      }
    }
    if (arg === 'add') {
      const bad = addProblem({
        ...addOpts(extra[0]!),
        readStdin: async () => '',
        stdinIsTTY: false,
      });
      if (bad) {
        io.err(`sbx: ${bad}`);
        return SBX_EXIT.usage;
      }
    }
  }

  // A sandbox bound by .sbx/sandbox.json lives on the control plane `sbx up` used, which may not be
  // the one remembered at login (a `sbx mcp` started by an agent has no MOCACTL_SBX_URL): the flag
  // and the environment still win (R5j).
  const flagUrl = values['control-plane-url'] || (env.MOCACTL_SBX_URL ? undefined : boundUrl);
  const fromBinding = !values['control-plane-url'] && flagUrl !== undefined;
  // --record F: every HTTP attempt this command makes, the login's refresh included, so the record
  // is opened (or refused) before the runtime's clients exist. Exec calls are gRPC, not recorded.
  if (values.record !== undefined) {
    const r = openCallRecord(values.record, `sbx ${command}`, deps.now);
    if ('error' in r) {
      io.err(`sbx: ${r.error}`);
      return SBX_EXIT.usage;
    }
    record.recorder = r;
    const base = resolveSbxUrl(
      flagUrl,
      env,
      loadConfig(resolvePaths(env, deps.home ?? homedir())).config,
    );
    deps = { ...deps, fetchImpl: r.wrap(deps.fetchImpl ?? fetch, base ?? 'http://invalid') };
  }
  const opened = await openSbx({ controlPlaneUrl: flagUrl }, env, io, deps, {
    login: OWN_LOGIN.has(command),
    ...(fromBinding ? { urlFrom: '.sbx/sandbox.json' } : {}),
  });
  if (typeof opened === 'number') return opened;
  const ctx: SbxCtx = {
    ...opened,
    io,
    json: values.json === true,
    signal: deps.signal,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };

  switch (command) {
    case 'login':
      return cmdLogin(
        ctx,
        values['control-plane-url'] !== undefined,
        values['no-browser'] ? undefined : deps.loginHelpers,
      );
    case 'logout':
      return cmdLogout(ctx);
    case 'quota':
      return cmdQuota(ctx);
    case 'policy':
      return cmdPolicy(ctx);
    case 'templates':
      if (arg === 'create' || arg === 'build') {
        if (values['dry-run']) return cmdDryRun(ctx, createInputs!);
        return cmdCreateTemplates(ctx, createInputs!, {
          ...(arg === 'build' ? { build: extra[0]! } : {}),
          ...(timeout !== undefined ? { timeoutS: timeout } : {}),
        });
      }
      if (arg === 'follow')
        return cmdFollowTemplate(ctx, extra[0]!, {
          ...(values.build !== undefined ? { build: values.build } : {}),
          ...(timeout !== undefined ? { timeoutS: timeout } : {}),
        });
      if (arg === 'cancel') return cmdCancelBuild(ctx, extra[0]!, values.build!);
      if (arg === 'show') return cmdShowTemplate(ctx, extra[0]!, values.build);
      if (arg === 'tag') return cmdTagTemplate(ctx, extra[0]!, extra.slice(1), values.build!);
      if (arg === 'untag') return cmdUntagTemplate(ctx, extra[0]!, extra[1]!);
      if (arg === 'edit')
        return cmdEditTemplate(ctx, extra[0]!, {
          ...(values.visibility !== undefined ? { visibility: values.visibility } : {}),
          ...(values.description !== undefined ? { description: values.description } : {}),
        });
      if (arg === 'transfer') return cmdTransferTemplate(ctx, extra[0]!, extra[1]!);
      if (arg === 'activate')
        return cmdActivate(ctx, extra[0]!, {
          ...(values.build !== undefined ? { build: values.build } : {}),
          ...(leaseSeconds !== undefined ? { leaseSeconds } : {}),
          wait: values.wait === true,
          ...(timeout !== undefined ? { timeoutS: timeout } : {}),
        });
      if (arg === 'deactivate') return cmdDeactivate(ctx, extra[0]!, values['stop-now'] === true);
      if (arg === 'retire')
        return cmdRetire(ctx, extra[0]!, {
          ...(values.build !== undefined ? { build: values.build } : {}),
          ...(values.reason !== undefined ? { reason: values.reason } : {}),
          wait: values.wait === true,
          ...(timeout !== undefined ? { timeoutS: timeout } : {}),
        });
      return cmdTemplates(ctx);
    case 'hosts':
      return cmdHosts(ctx);
    case 'create':
      return cmdCreate(ctx, createBody!, {
        seed: values.seed === true,
        ...(deps.execFactory ? { factory: deps.execFactory } : {}),
      });
    case 'ls':
      return cmdLs(ctx, values.all === true);
    case 'get':
      return cmdGet(ctx, id!, deps.execFactory);
    case 'mode':
      return cmdMode(ctx, id!, arg as SandboxModeName, {
        ...(modeIdle !== undefined ? { idleTimeoutS: modeIdle } : {}),
        tty: deps.stdinIsTTY === true,
        boundHere: readBoundSandbox(deps.cwd ?? process.cwd()) === id,
        ...(deps.execFactory ? { factory: deps.execFactory } : {}),
      });
    case 'reset':
      return cmdReset(ctx, id!, deps.execFactory);
    case 'rm': {
      // The bound sandbox gone, its configuration goes too: `sbx rm` takes back what `up` added.
      const f = findSandboxFile(deps.cwd ?? process.cwd());
      const bindingRoot = f ? dirname(dirname(f)) : undefined;
      const bound = bindingRoot !== undefined && readBoundSandbox(bindingRoot) === id;
      // "Already gone" only from the control plane the binding names: another one not knowing
      // the id says nothing about the bound sandbox, so that 404 stays a failure.
      const bindingUrl =
        bindingRoot !== undefined ? readBinding(bindingRoot)?.controlPlaneUrl : undefined;
      const sameCp = bindingUrl !== undefined && normalizeUrl(bindingUrl) === normalizeUrl(ctx.url);
      // Never delete unpulled work unasked: checked first, unless --force (final review I3).
      if (!values.force) {
        const refused = await checkBeforeRm(ctx, id!, bound, deps.execFactory);
        if (refused !== undefined) return refused;
      }
      const code = await cmdRm(ctx, id!, {
        goneOk: bound && sameCp,
        ...(deps.execFactory ? { factory: deps.execFactory } : {}),
      });
      if (code !== SBX_EXIT.ok || values['keep-config'] || !bound) return code;
      return unbind(ctx, bindingRoot!);
    }
    case 'credentials':
      if (arg === 'add') {
        return addCredential(ctx, {
          ...addOpts(extra[0]!),
          readStdin: deps.readStdin ?? (async () => ''),
          stdinIsTTY: deps.stdinIsTTY === true || !deps.readStdin,
        });
      }
      return arg === 'delete' ? deleteCredential(ctx, extra[0]!) : listCredentials(ctx);
    case 'doctor':
      return cmdDoctor(ctx, root, id, deps.execFactory, deps.claudeVersion, deps.agentop);
    case 'token':
      return cmdToken(ctx, id!, renewEvery);
    case 'egress':
      return cmdEgress(ctx, id!, values.ndjson === true, values.verify === true);
    case 'run':
      return cmdRun(ctx, id!, script!, timeout, deps.execFactory, runRetry(env, deps, ctx));
    case 'put':
      return cmdPut(ctx, id!, target!, content!, deps.execFactory, runRetry(env, deps, ctx));
    case 'mcp':
      return cmdMcp(ctx, id!, deps.mcpTransport, deps.execFactory);
    case 'claude':
      // As for codex: only an explicit --sandbox is passed on — without one, the `mocactl sbx mcp`
      // that claude starts resolves the binding itself, so the agent follows .sbx/sandbox.json as
      // it changes. Claude Code passes its whole environment to a stdio server, so the env-var
      // URL case needs no help (#639 was Codex-specific); an explicit --control-plane-url is
      // forwarded (as the normalized ctx.url) because a flag is not the environment. The local
      // tools are denied unless this is a repository `up --cortex` set up (#702); outside a
      // repository, or with a record that cannot be read, they are denied.
      return cmdClaude(
        ctx,
        positionals.slice(1),
        deps.claude ?? {},
        values.sandbox,
        values['control-plane-url'] !== undefined ? ctx.url : undefined,
        await repoRoot(cwd).then(cortexMode, () => false),
      );
    case 'codex':
      // Only an explicit --sandbox is passed on: without one, the `mocactl sbx mcp` that codex
      // starts resolves the binding itself, so the agent follows .sbx/sandbox.json as it changes.
      // --control-plane-url is forwarded (as the normalized ctx.url) because codex does not give
      // the server its environment, so the server cannot see MOCACTL_SBX_URL or the flag (#639
      // review); FORWARDED_ENV carries the env-var case.
      return cmdCodex(
        ctx,
        positionals.slice(1),
        deps.codex ?? {},
        values.sandbox,
        values['control-plane-url'] !== undefined ? ctx.url : undefined,
      );
    case 'up':
      return cmdUp(
        ctx,
        root!,
        {
          force: false,
          includeSecrets: values['include-secrets'] === true,
          ...(maxPush !== undefined ? { maxPush } : {}),
          ...(values.template ? { template: values.template } : {}),
          ...(values.name ? { name: values.name } : {}),
          noAgentConfig: values['no-agent-config'] === true,
          cortex: values.cortex === true,
          ...(upBound ? { boundId: upBound } : {}),
          cwd,
        },
        deps.execFactory,
        deps.agentop,
      );
    case 'push':
      return cmdPush(
        ctx,
        root!,
        id!,
        {
          force: values.force === true,
          includeSecrets: values['include-secrets'] === true,
          ...(maxPush !== undefined ? { maxPush } : {}),
          cwd,
        },
        deps.execFactory,
      );
    case 'pull':
      return cmdPull(
        ctx,
        id!,
        {
          apply: values.apply === true,
          ...(values.out !== undefined ? { out: values.out } : {}),
          ...(root ? { root } : {}),
        },
        deps.cwd ?? process.cwd(),
        deps.execFactory,
      );
    default:
      return cmdEnv(ctx, id!);
  }
}
