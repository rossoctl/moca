import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MAX_STDIN_BYTES, q, WORKSPACE } from '@moca/sandbox-client';
import { loadConfig, normalizeUrl, resolvePaths, type Paths, type TuiConfig } from '../config.js';
import { sanitizeRemote } from '../core/sanitize.js';
import type { Io, LoginHelpers } from '../headless.js';
import { buildRuntime, ensureRuntimeAuth, type Runtime } from '../runtime.js';
import { SandboxApiClient } from './api.js';
import {
  cmdCreate,
  cmdEnv,
  cmdLogin,
  cmdLogout,
  cmdLs,
  cmdRm,
  cmdTemplates,
  cmdToken,
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
import { cmdMcp, cmdPut, cmdRun, parseTimeout, workspacePath } from './run.js';
import { PushError, repoRoot } from './push.js';
import { findSandboxFile, readBinding, readBoundSandbox, SANDBOX_ID_RE } from './state.js';
import { checkBeforeRm, cmdPull, cmdPush, cmdUp, DEFAULT_TEMPLATE, unbind } from './sync.js';
import { type AgentopExec } from './agentop.js';

export const SBX_USAGE = `usage (the sandbox service, SBX0):
  mocactl sbx login [--control-plane-url URL] [--no-browser]
                                                 log in with the GitHub device flow (the URL is remembered;
                                                 in a local terminal: copies the code, opens the browser)
  mocactl sbx logout                             end the sandbox-service login (deletes sbx-auth.json)
  mocactl sbx templates [--json]                 the templates a sandbox can be created from
  mocactl sbx create [--template ID] [--name N] [--label k=v ...] [--json]
                                                 create a sandbox (template: default); prints its id
  mocactl sbx ls [--all] [--json]                your sandboxes (--all: everyone's; admins only)
  mocactl sbx rm [ID] [--keep-config] [--force] [--json]
                                                 delete a sandbox; for the bound one, also take
                                                 back the agent configuration sbx up added, and
                                                 .sbx/ (unless --keep-config) (refused while the
                                                 sandbox has changes not yet pulled, unless --force,
                                                 or when that cannot be checked)
  mocactl sbx token [ID] [--json]                print a fresh sandbox token (15 minutes by default)
  mocactl sbx env [ID]                           shell exports for a direct sandbox/v1 client
  mocactl sbx run [--sandbox ID] [--timeout S] [-- CMD ...]   run CMD (or the script on stdin) in /workspace
                                                 (CMD's words are quoted, so they run exactly as typed:
                                                 for pipes, $VARS or globs use stdin or -- sh -c '...';
                                                 exit: the command's code; 124 timed out or killed;
                                                 125 sandbox failure; S defaults to, and is capped at,
                                                 the sandbox token's lifetime minus 60 s)
  mocactl sbx put PATH [--sandbox ID]            write stdin to PATH under /workspace
  mocactl sbx mcp [--sandbox ID]                 the stdio MCP server for Claude Code / OpenCode
  mocactl sbx claude [-- CLAUDE_ARGS ...]        run Claude Code on this sandbox's MCP tools, for
                                                 one run (--mcp-config + --strict-mcp-config,
                                                 nothing written, no approval asked: the first
                                                 bare claude session's approval question is why
                                                 this exists, #577; Claude Code still asks once
                                                 whether you trust the folder. The session loads
                                                 no MCP server but the sandbox's; run claude
                                                 yourself for your own servers)
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
ID (or --sandbox ID) defaults to the sandbox in the nearest .sbx/sandbox.json. The control plane
comes from --control-plane-url, MOCACTL_SBX_URL, the bound sandbox's, or the one remembered at
login. The login is kept apart from \`mocactl login\`'s, so both can be active at once.
exit: 0 ok, 1 failed, 2 usage, 3 log in first, 4 control plane unreachable`;

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
): string | undefined {
  return normalizeUrl(flag || env.MOCACTL_SBX_URL || config.sbxControlPlaneUrl);
}

/** Where resolveSbxUrl's answer came from, by the same precedence (and the same `||`). */
export function sbxUrlSource(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  config: TuiConfig,
): 'flag' | 'env' | 'config' | undefined {
  if (flag) return 'flag';
  if (env.MOCACTL_SBX_URL) return 'env';
  return config.sbxControlPlaneUrl ? 'config' : undefined;
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
  const url = resolveSbxUrl(flags.controlPlaneUrl, env, remembered);
  if (!url) {
    io.err('sbx: no sandbox control plane: pass --control-plane-url URL, or set MOCACTL_SBX_URL');
    return SBX_EXIT.usage;
  }
  const explicitUrl =
    sbxUrlSource(flags.controlPlaneUrl, env, remembered) === 'config' ? undefined : url;
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
]);
/** The commands that open without the login check: they log in, out, or check it themselves (R7). */
const OWN_LOGIN = new Set(['login', 'logout', 'doctor']);
/** The commands that act on one sandbox: `[ID]` as an argument (or `--sandbox ID`). */
const TAKES_ID_ARG = new Set(['rm', 'token', 'env']);
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
  ),
  string[],
][] = [
  ['force', ['push', 'rm']],
  ['include-secrets', ['up', 'push']],
  ['max-push', ['up', 'push']],
  ['apply', ['pull']],
  ['out', ['pull']],
  ['no-agent-config', ['up']],
  ['cortex', ['up']],
  ['keep-config', ['rm']],
  ['no-browser', ['login']],
];
/** `--max-push` in MiB: up to 4 GiB, far above what a push should ever be. */
const MAX_PUSH_MIB = 4096;

const mib = (n: number) => `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) ? 1 : 0)} MiB`;

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
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'control-plane-url': { type: 'string' },
        template: { type: 'string' },
        name: { type: 'string' },
        label: { type: 'string', multiple: true },
        all: { type: 'boolean' },
        json: { type: 'boolean' },
        sandbox: { type: 'string' },
        timeout: { type: 'string' },
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
  if (values.timeout !== undefined && command !== 'run') {
    io.err(`sbx: --timeout only applies to run\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  const flagMisuse = SYNC_FLAGS.find(
    ([flag, cmds]) => values[flag] !== undefined && !cmds.includes(command),
  );
  if (flagMisuse) {
    io.err(`sbx: --${flagMisuse[0]} only applies to ${flagMisuse[1].join(' and ')}\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
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
  // `run` takes everything after the command (after `--`) as CMD; `put` exactly one PATH; rm, token
  // and env at most one ID; every other command no argument at all.
  const argsOk =
    // run quotes its CMD; claude and codex forward their own flags and prompt to the child.
    command === 'run' ||
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
  if (TAKES_SANDBOX_FLAG.has(command)) {
    id = (TAKES_ID_ARG.has(command) ? arg : undefined) ?? values.sandbox;
    if (id === undefined) {
      const bound = readBinding(root ?? deps.cwd ?? process.cwd());
      id = bound?.id;
      boundUrl = bound?.controlPlaneUrl;
    }
    // No sandbox is one of doctor's failed checks (it says how to bind one), not a usage error.
    if (!id && command !== 'doctor') {
      io.err(
        TAKES_ID_ARG.has(command)
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
  const timeout = parseTimeout(io, values.timeout);
  if (timeout === null) return SBX_EXIT.usage;
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
  let createBody: { template: string; name?: string; labels?: Record<string, string> } | undefined;
  if (command === 'create') {
    const labels = parseLabels(io, values.label ?? []);
    if (!labels) return SBX_EXIT.usage;
    createBody = {
      template: values.template ?? DEFAULT_TEMPLATE,
      ...(values.name ? { name: values.name } : {}),
      ...(Object.keys(labels).length ? { labels } : {}),
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
  const opened = await openSbx({ controlPlaneUrl: flagUrl }, env, io, deps, {
    login: OWN_LOGIN.has(command),
    ...(fromBinding ? { urlFrom: '.sbx/sandbox.json' } : {}),
  });
  if (typeof opened === 'number') return opened;
  const ctx: SbxCtx = { ...opened, io, json: values.json === true, signal: deps.signal };

  switch (command) {
    case 'login':
      return cmdLogin(
        ctx,
        values['control-plane-url'] !== undefined,
        values['no-browser'] ? undefined : deps.loginHelpers,
      );
    case 'logout':
      return cmdLogout(ctx);
    case 'templates':
      return cmdTemplates(ctx);
    case 'create':
      return cmdCreate(ctx, createBody!);
    case 'ls':
      return cmdLs(ctx, values.all === true);
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
      const code = await cmdRm(ctx, id!, { goneOk: bound && sameCp });
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
      return cmdToken(ctx, id!);
    case 'run':
      return cmdRun(ctx, id!, script!, timeout, deps.execFactory);
    case 'put':
      return cmdPut(ctx, id!, target!, content!, deps.execFactory);
    case 'mcp':
      return cmdMcp(ctx, id!, deps.mcpTransport, deps.execFactory);
    case 'claude':
      // As for codex: only an explicit --sandbox is passed on — without one, the `mocactl sbx mcp`
      // that claude starts resolves the binding itself, so the agent follows .sbx/sandbox.json as
      // it changes. Claude Code passes its whole environment to a stdio server, so the env-var
      // URL case needs no help (#639 was Codex-specific); an explicit --control-plane-url is
      // forwarded (as the normalized ctx.url) because a flag is not the environment.
      return cmdClaude(
        ctx,
        positionals.slice(1),
        deps.claude ?? {},
        values.sandbox,
        values['control-plane-url'] !== undefined ? ctx.url : undefined,
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
