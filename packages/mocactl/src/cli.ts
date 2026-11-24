import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { parseOptionFlags } from './core/session-options.js';
import type { CredentialConsumer } from './api/types.js';
import {
  cmdAuthToken,
  cmdBundleDelete,
  cmdBundleList,
  cmdCredentialAdd,
  cmdCredentialDelete,
  cmdCredentials,
  cmdDoctor,
  cmdLogin,
  cmdLoginTestUser,
  cmdLogout,
  cmdPromote,
  cmdRun,
  cmdSessionDelete,
  cmdSessions,
  type Io,
  type LoginHelpers,
} from './headless.js';
import { DiscoveringHarness } from './api/discovery.js';
import { buildRuntime, ensureRuntimeAuth, type Runtime } from './runtime.js';
import { openCallRecord, RUN_LENGTH_FIELDS, type CallRecorder } from './sbx/call-record.js';
import { defaultSbxUrl, openSbxRuntime, sbxMain } from './sbx/cli.js';
import { stdioTransport } from './sbx/mcp.js';
import {
  cmdCancel,
  cmdDecide,
  cmdFollowUp,
  cmdGet,
  cmdSpawn,
  cmdSubagents,
  cmdWatch,
  MAX_PROMPT_BYTES,
  runSpawnWorker,
} from './subagent.js';
import { serveSubagentMcp } from './subagent-mcp.js';
import { WORKLOAD_MOUNTS, type WorkloadMount } from './api/workloads.js';
import {
  cmdWorkloadCreate,
  cmdWorkloadDelete,
  cmdWorkloadGet,
  cmdWorkloadList,
} from './workloads.js';
import { versionLine } from './version.js';
import { versionReport, type VersionTarget } from './version-report.js';
import { commandUsage, typedWords } from './core/usage.js';

/**
 * Bare `mocactl` and `mocactl --help`: what mocactl is, and its commands one line each. Each
 * command's details are `mocactl COMMAND --help` (cut from USAGE) or `mocactl sbx --help`.
 */
export const SUMMARY = `mocactl provides a harness service and a sandbox service.

The sandbox service (\`mocactl sbx\`) creates and manages remote VMs that hold a copy of your code
repository, and patches Claude Code and other agents to work on that copy instead of your local
machine. The harness service (\`mocactl harness\`) goes one step further, running the agent
remotely.

usage: mocactl COMMAND [ARGS...]

the sandbox service:
  sbx            remote VMs holding your repository, for your agent: login, up, pull, rm, ...

the harness service:
  harness        the interactive terminal UI: chat with an agent running remotely
  run            run one turn and print its reply
  sessions       list or delete your sessions
  spawn          fork a detached subagent
  subagents      list spawned subagents and their state
  watch          follow subagents' state changes until they finish
  get            write a subagent's result files
  approve        let a subagent paused for approval go ahead
  reject         tell a subagent paused for approval to take another route
  follow-up      send a finished subagent a second turn on the same session
  cancel         stop a subagent dispatched with \`spawn --async\`
  mcp            serve the subagent commands to a coding agent as MCP tools
  promote        upload a directory's Claude Code skills and commands as a config bundle
  bundles        list or delete your promoted config bundles
  workloads      create, list, get or delete workloads (contexts for subagents)
  credentials    list, add or delete your credentials

login and setup (the harness service; \`mocactl sbx login\` is the sandbox service's):
  login          log in with the GitHub device flow
  logout         end this login
  auth token     print a valid API token
  doctor         check the setup; one fix per failure

  --version      print this build's version (CLI version: ...), and the control planes' versions
                 and URLs

Run \`mocactl COMMAND --help\` for a command's details (\`mocactl sbx --help\` for the sandbox
service's commands).`;

export const USAGE = `usage:
  mocactl harness [--setup] [--no-animation]     interactive terminal UI (--setup: run the first-start
                                                 setup again: the server form, then login and
                                                 credential, each skipped when already done;
                                                 --no-animation: a still spinner)
  mocactl --version                              print this build's version as "CLI version: V" (a
                                                 release tag, edge-<sha>, or dev-<sha> from a source
                                                 checkout), then each configured control plane's
                                                 (harness and sandbox service) version and URL, or
                                                 unreachable
  mocactl login [--no-browser]                   log in with the GitHub device flow (in a local
                                                 terminal: copies the code, opens the browser;
                                                 --no-browser: only prints the URL and the code)
  mocactl login --test-user N                    log in as test user N (needs the control plane's
                                                 SH_TEST_USERS; secret in MOCA_TEST_USER_SECRET)
  mocactl logout [--all]                         end this login (--all: every login of yours)
  mocactl auth token [--json]                    print a valid API token, refreshing if needed
                                                 (exit 3: log in first; 4: control plane unreachable)
  mocactl doctor [--json]                        check the setup; one fix per failure
  mocactl run "prompt" [--session ID | --new] [--option key=value ...] [--json]
                                                 run one turn and print its reply: in session ID
                                                 (--session), or in a new session (--new, the
                                                 default); --option sets a new session's model,
                                                 inferenceCredential, sandboxTier or sandboxTemplate
                                                 (repeatable; other keys are ignored; with several
                                                 inference credentials and none given, refused,
                                                 naming them; the others not given take the
                                                 server's default; ignored with --session)
  mocactl run "prompt" --config DIGEST            start the new session with a promoted config bundle
  mocactl run "prompt" --show-tools              print each tool call the turn makes, between its
                                                 text (not with --json, which streams the frames)
  mocactl run "prompt" --record F                append one NDJSON line per HTTP attempt to F (0600):
                                                 path, status, times, ids; a stream's bytes, sha256
                                                 and frame count; never a token, host, prompt,
                                                 reply or patch (kept as sha256 or length)
  mocactl promote DIR [--dry-run] [--json]       upload DIR's .claude/skills and .claude/commands
                                                 (--dry-run: build and report, upload nothing)
  mocactl bundles list [--json]                  your own stored bundles, newest first
  mocactl bundles delete DIGEST [--json]         delete a bundle you promoted and free its budget
  mocactl sbx …                                  the sandbox service, workspaces in isolated VMs for your agent: login, up, pull, rm (mocactl sbx --help)
  mocactl sessions [--json]                      list your sessions
  mocactl sessions delete ID [--json]
  mocactl credentials [--json]                   list your credentials (never their secrets)
  mocactl credentials add NAME --host HOST [--host HOST ...] [--kind KIND] [--consumer CONSUMER]
      [--endpoint URL] [--json]                  the secret is read from stdin; --host: a host it is
                                                 sent to (repeatable, or a comma list); --kind:
                                                 bearer (default), api-key, oauth2-token or basic
                                                 (stdin is username=... and password=... lines;
                                                 basic needs --consumer sandbox-egress or
                                                 control-plane: inference takes one secret);
                                                 --consumer: inference (default: the model calls),
                                                 sandbox-egress or control-plane; --endpoint: the
                                                 model API URL it is for (inference only)
  mocactl credentials delete NAME [--json]
  mocactl spawn "prompt" [--config DIGEST] --kind prompt|solve
      [--repo URL --ref REF] [--tag T] [--label L] [--json]
                                                 fork a detached subagent (--kind prompt: it answers
                                                 in text; solve: it returns a patch to the
                                                 repository --repo at --ref, which solve needs;
                                                 --config: its session's promoted config bundle;
                                                 --tag groups spawns for subagents and watch;
                                                 --label names one dispatch within a --tag group,
                                                 surfaced on 'mocactl subagents --json' as label)
  mocactl spawn --prompt-file FILE [...]         read the prompt from FILE (UTF-8, trimmed); use when
                                                 the prompt would otherwise be awkward on argv
  mocactl spawn "prompt" --kind prompt --workload ID [--writable] [...]
                                                 run the subagent on the context of workload ID
                                                 (--workload needs --kind prompt; --writable: its
                                                 own copy, discarded after)
  mocactl spawn "prompt" --async [...]            dispatch as a cancellable async turn instead of a
                                                 local worker process (needs SH_ASYNC_DRAIN on the
                                                 deployment; not available with --workload)
  mocactl spawn "prompt" --require-approval [...]  park the subagent before it acts: it proposes
                                                 what it would do and waits for 'mocactl approve'
                                                 or 'mocactl reject'
  mocactl spawn "prompt" --max-concurrent N [...]
                                                 refuse the dispatch when N of your subagents are
                                                 already running (default 4)
  mocactl subagents [--tag T] [--json]            list spawned subagents + current state (--tag:
                                                 only those spawned with --tag T)
  mocactl watch [--tag T] [--since C] [--json]   one line per state change, until every watched
                                                 subagent is finished (--tag: only those spawned
                                                 with --tag T; --json: one JSON object per line,
                                                 for an agent's background monitor; --since
                                                 resumes the event stream after cursor C)
  mocactl get SESSIONID [--out DIR] [--json]      write result files + bounded summary (--out: into
                                                 DIR; default: the current directory)
  mocactl get SESSIONID --wait [--timeout S]     --wait: block until the result is there, then write
                                                 it (--timeout: at most S seconds, default 300;
                                                 exit 1 and status 'queued' if the
                                                 budget runs out, 'unknown' if the run is over
                                                 without one)
  mocactl approve SESSIONID [--gate N] [--feedback TEXT] [--json]
                                                 let a subagent paused for approval go ahead; prints
                                                 the turn it resumed as ('mocactl get SESSIONID'
                                                 shows what it proposed and the number --gate takes,
                                                 which is read off the paused run when the flag is
                                                 left out; --feedback: a note that reaches the
                                                 subagent)
  mocactl reject SESSIONID [--gate N] [--feedback TEXT] [--json]
                                                 refuse what the subagent proposed, and it carries
                                                 on from there (--feedback says what to do instead,
                                                 at most 4096 bytes; --gate as for approve)
  mocactl follow-up SESSIONID "prompt" [--out DIR] [--json]
                                                 send a second turn to a finished subagent, which
                                                 keeps the first turn's context; the result is
                                                 written to --out DIR (default: the current
                                                 directory) first, because a new turn overwrites it
  mocactl cancel SESSIONID [--json]              stop a subagent dispatched with 'spawn --async': a
                                                 queued turn never starts, a running one is asked to
                                                 stop and 'mocactl get SESSIONID' reports how it
                                                 ended (a subagent spawned without --async has no
                                                 turn record, and cannot be cancelled)
  mocactl mcp                                    serve the subagent commands (spawn, list, get,
                                                 follow_up, approve, reject, cancel) to a coding
                                                 agent as MCP tools over stdin/stdout, so it needs
                                                 no shell and parses no output; add it with
                                                 'claude mcp add moca -- mocactl mcp'
  mocactl workloads create --context FILE [--name NAME] [--json]
      [--sandboxes N [--mount read-only|writable]]
                                                 upload a context file (--context, made by
                                                 contextctl ctx pack) to a new workload; prints
                                                 its id (--name: the id; default: wl- and 8 hex
                                                 digits; --sandboxes: N
                                                 sandboxes of its own; --mount: its context on
                                                 their own volume, no per-run copy)
  mocactl workloads list [--json]                your own live workloads, newest first
  mocactl workloads get ID [--json]
  mocactl workloads delete ID [--json]           delete a workload and its context
flags for every command: --control-plane-url URL
  (the control plane says where the harness is; --harness-url URL overrides that)
--json: print the result as JSON on stdout, for a script`;

const CREDENTIAL_FLAGS = ['kind', 'consumer', 'host', 'endpoint'] as const;

/**
 * The usage for what was typed: `mocactl COMMAND [SUB...]`'s own entries (commandUsage) with the
 * flags every command takes, or the whole usage when no command is named or known.
 */
export function usageFor(words: string[]): string {
  const own = commandUsage(USAGE, '  mocactl ', words);
  if (own === undefined) return SUMMARY;
  const notes = USAGE.slice(USAGE.lastIndexOf('\nflags for every command') + 1);
  // The --json note only for a command that takes --json, as `mocactl sbx COMMAND --help` does.
  const everyCommand = /--json\b/.test(own) ? notes : notes.replace(/\n--json:[^\n]*$/, '');
  return `usage:\n${own}\n${everyCommand}\nRun \`mocactl --help\` for the list of all commands.`;
}

function usage(io: Io, text: string): number {
  io.err(text);
  return 2;
}

function unknown(io: Io, command: string, sub: string, text: string): number {
  io.err(`unknown ${command} command "${sub}"\n${text}`);
  return 2;
}

export interface InteractiveOptions {
  setup: boolean;
  noAnimation: boolean;
}

export type StartInteractive = (rt: Runtime, opts: InteractiveOptions) => Promise<number>;

export interface MainDeps {
  buildRuntime?: typeof buildRuntime;
  startInteractive?: StartInteractive;
  signal?: AbortSignal;
  /**
   * Whether stdin is a terminal; Ink needs raw mode, so the interactive UI refuses without one,
   * and `credentials add` wants its secret piped.
   */
  stdinIsTTY?: boolean;
  /** Whether stdout is a terminal: `sbx proc logs` then removes control sequences. */
  stdoutIsTTY?: boolean;
  /** All of stdin; `credentials add` reads its secret from it, `sbx run` its script. */
  readStdin?: () => Promise<string>;
  /** All of stdin, byte for byte (at least `limit` bytes when given): `sbx put`'s content. */
  readStdinBytes?: (limit?: number) => Promise<Buffer>;
  /** `login`'s clipboard and browser; absent when nobody is at this machine's screen. */
  loginHelpers?: LoginHelpers;
  /** The fetch every client uses; `run --record` wraps it. Tests only. */
  fetchImpl?: typeof fetch;
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: MainDeps = {},
): Promise<number> {
  const opened: { recorder?: CallRecorder } = {};
  try {
    return await mainWith(argv, env, io, deps, opened);
  } finally {
    opened.recorder?.close();
  }
}

/** mocactl's flags (all but `mocactl sbx`'s): one table, for the parse and for typedWords. */
const OPTIONS = {
  'control-plane-url': { type: 'string' },
  'harness-url': { type: 'string' },
  session: { type: 'string' },
  'test-user': { type: 'string' },
  new: { type: 'boolean' },
  option: { type: 'string', multiple: true },
  json: { type: 'boolean' },
  'show-tools': { type: 'boolean' },
  kind: { type: 'string' },
  consumer: { type: 'string' },
  host: { type: 'string', multiple: true },
  endpoint: { type: 'string' },
  config: { type: 'string' },
  all: { type: 'boolean' },
  'no-browser': { type: 'boolean' },
  setup: { type: 'boolean' },
  'no-animation': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  repo: { type: 'string' },
  ref: { type: 'string' },
  tag: { type: 'string' },
  since: { type: 'string' },
  label: { type: 'string' },
  out: { type: 'string' },
  wait: { type: 'boolean' },
  timeout: { type: 'string' },
  'max-concurrent': { type: 'string' },
  workload: { type: 'string' },
  writable: { type: 'boolean' },
  async: { type: 'boolean' },
  'require-approval': { type: 'boolean' },
  gate: { type: 'string' },
  feedback: { type: 'string' },
  context: { type: 'string' },
  name: { type: 'string' },
  sandboxes: { type: 'string' },
  mount: { type: 'string' },
  'prompt-file': { type: 'string' },
  record: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
} satisfies ParseArgsConfig['options'];

/** The flags bare `mocactl` takes: help, version, and the URLs every command takes. */
const BARE_FLAGS = new Set(['help', 'version', 'control-plane-url', 'harness-url']);

async function mainWith(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: MainDeps,
  opened: { recorder?: CallRecorder },
): Promise<number> {
  // `mocactl sbx` (SBX0) is its own command group with its own flags and its own control plane, so
  // it is dispatched before the global flag table rather than widening it.
  if (argv[0] === 'sbx') {
    return sbxMain(argv.slice(1), env, io, {
      signal: deps.signal,
      stdinIsTTY: deps.stdinIsTTY,
      stdoutIsTTY: deps.stdoutIsTTY,
      readStdin: deps.readStdin,
      readStdinBytes: deps.readStdinBytes,
      loginHelpers: deps.loginHelpers,
    });
  }
  // A usage error shows the help of the command it is about, as --help does.
  const help = usageFor(typedWords(argv, OPTIONS));
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: OPTIONS,
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n${help}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.out(`CLI version: ${versionLine()}\n`);
    // Then each configured control plane's version (public discovery, no login needed): the
    // harness service's, and the sandbox service's. Neither configured: the version alone.
    const targets: VersionTarget[] = [];
    const fetchImpl = deps.fetchImpl ?? fetch;
    const rt = (deps.buildRuntime ?? buildRuntime)(
      { controlPlaneUrl: values['control-plane-url'], harnessUrl: values['harness-url'] },
      env,
      undefined,
      fetchImpl,
    );
    const cp = rt.cp;
    if (rt.endpoints.controlPlaneUrl && cp) {
      targets.push({
        label: 'control plane',
        url: rt.endpoints.controlPlaneUrl,
        discovery: (o) => cp.discovery(o),
      });
    }
    const sbxUrl = defaultSbxUrl(env);
    if (sbxUrl) {
      const { api } = openSbxRuntime(sbxUrl, env, { fetchImpl });
      targets.push({
        label: 'sandbox control plane',
        url: sbxUrl,
        discovery: (o) => api.discovery(o),
      });
    }
    for (const line of await versionReport(targets)) io.out(line + '\n');
    return 0;
  }
  if (values.help) {
    // `mocactl COMMAND --help`: that command's syntax, not every command's.
    io.out(help + '\n');
    return 0;
  }
  if (positionals.length === 0) {
    // Bare `mocactl`: what it is and its commands. The interactive UI is `mocactl harness`.
    const tuiFlag = (['setup', 'no-animation'] as const).find((f) => values[f] !== undefined);
    if (tuiFlag) {
      io.err(`--${tuiFlag} only applies to \`mocactl harness\`\n${usageFor(['harness'])}`);
      return 2;
    }
    // Any other flag but the URLs every command takes belongs to a command that was not typed:
    // refused, as it was before the summary, so a mistyped command is not silently accepted.
    const stray = Object.keys(values).find((f) => !BARE_FLAGS.has(f));
    if (stray) {
      io.err(`--${stray} needs a command\n${SUMMARY}`);
      return 2;
    }
    io.out(SUMMARY + '\n');
    return 0;
  }

  // --record F: every HTTP attempt `run` makes, to the control plane and the harness, the login's
  // refresh included, so the record is opened (or refused) before the runtime's clients exist.
  let fetchImpl = deps.fetchImpl ?? fetch;
  if (values.record !== undefined) {
    if (positionals[0] !== 'run') {
      io.err(`--record only applies to \`mocactl run\` (and to \`mocactl sbx\` commands)\n${help}`);
      return 2;
    }
    const r = openCallRecord(values.record, 'run', Date.now, { lengthFields: RUN_LENGTH_FIELDS });
    if ('error' in r) {
      io.err(r.error);
      return 2;
    }
    opened.recorder = r;
    fetchImpl = r.wrapEndpoints(fetchImpl, () => [
      { endpoint: 'control-plane', url: rt.endpoints.controlPlaneUrl },
      {
        endpoint: 'harness',
        url:
          rt.endpoints.harnessUrl ??
          (rt.harness instanceof DiscoveringHarness ? rt.harness.discoveredUrl() : undefined),
      },
    ]);
  }
  const rt = (deps.buildRuntime ?? buildRuntime)(
    { controlPlaneUrl: values['control-plane-url'], harnessUrl: values['harness-url'] },
    env,
    undefined,
    fetchImpl,
  );
  if (rt.configWarning) io.err(rt.configWarning);

  const [command, ...rest] = positionals;
  const json = values.json === true;
  const { signal } = deps;
  if (!(command === 'credentials' && rest[0] === 'add')) {
    // --kind is shared with `spawn` (prompt|solve); the other three remain credentials-only.
    const stray = CREDENTIAL_FLAGS.filter((f) => !(f === 'kind' && command === 'spawn')).find(
      (f) => values[f] !== undefined,
    );
    if (stray) {
      io.err(`--${stray} only applies to \`mocactl credentials add\`\n${help}`);
      return 2;
    }
  }
  if (values.config !== undefined && command !== 'run' && command !== 'spawn') {
    io.err(`--config only applies to \`mocactl run\` and \`mocactl spawn\`\n${help}`);
    return 2;
  }
  const tuiFlag = (['setup', 'no-animation'] as const).find((f) => values[f] !== undefined);
  if (tuiFlag && command !== 'harness') {
    io.err(`--${tuiFlag} only applies to \`mocactl harness\`\n${help}`);
    return 2;
  }
  if (values.all !== undefined && command !== 'logout') {
    io.err(`--all only applies to \`mocactl logout\`\n${help}`);
    return 2;
  }
  if (values['no-browser'] !== undefined && command !== 'login') {
    io.err(`--no-browser only applies to \`mocactl login\`\n${help}`);
    return 2;
  }
  if (values['test-user'] !== undefined && command !== 'login') {
    io.err(`--test-user only applies to \`mocactl login\`\n${help}`);
    return 2;
  }
  if ((values.repo !== undefined || values.ref !== undefined) && command !== 'spawn') {
    io.err(`--repo and --ref only apply to \`mocactl spawn\`\n${help}`);
    return 2;
  }
  if (values.tag !== undefined && !['spawn', 'subagents', 'watch'].includes(command ?? '')) {
    io.err(
      `--tag only applies to \`mocactl spawn\`, \`mocactl subagents\` and \`mocactl watch\`\n${help}`,
    );
    return 2;
  }
  if (values.since !== undefined && command !== 'watch') {
    io.err(`--since only applies to \`mocactl watch\`\n${help}`);
    return 2;
  }
  if (values.label !== undefined && command !== 'spawn') {
    io.err(`--label only applies to \`mocactl spawn\`\n${help}`);
    return 2;
  }
  // `follow-up` writes the result it is about to overwrite, so it takes `get`'s destination flag.
  if (values.out !== undefined && command !== 'get' && command !== 'follow-up') {
    io.err(`--out only applies to \`mocactl get\` and \`mocactl follow-up\`\n${help}`);
    return 2;
  }
  const getOnly = (['wait', 'timeout'] as const).find((f) => values[f] !== undefined);
  if (getOnly && command !== 'get') {
    io.err(`--${getOnly} only applies to \`mocactl get\`\n${help}`);
    return 2;
  }
  // Refused rather than ignored: a timeout on a non-blocking read asks for nothing, and silently
  // dropping a flag in a script is worse than saying so (#419).
  if (values.timeout !== undefined && values.wait !== true) {
    io.err(`--timeout needs --wait: without it \`get\` reads once and returns\n${help}`);
    return 2;
  }
  if (values['max-concurrent'] !== undefined && command !== 'spawn') {
    io.err(`--max-concurrent only applies to \`mocactl spawn\`\n${help}`);
    return 2;
  }
  if (values.workload !== undefined && command !== 'spawn') {
    io.err(`--workload only applies to \`mocactl spawn\`\n${help}`);
    return 2;
  }
  if (values.async !== undefined && command !== 'spawn') {
    io.err(`--async only applies to \`mocactl spawn\`\n${help}`);
    return 2;
  }
  if (values.writable !== undefined && command !== 'spawn') {
    io.err(`--writable only applies to \`mocactl spawn\`\n${help}`);
    return 2;
  }
  if (values['require-approval'] !== undefined && command !== 'spawn') {
    io.err(`--require-approval only applies to \`mocactl spawn\`\n${help}`);
    return 2;
  }
  const decideOnly = (['gate', 'feedback'] as const).find((f) => values[f] !== undefined);
  if (decideOnly && command !== 'approve' && command !== 'reject') {
    io.err(`--${decideOnly} only applies to \`mocactl approve\` and \`mocactl reject\`\n${help}`);
    return 2;
  }
  if (values['prompt-file'] !== undefined && command !== 'spawn') {
    io.err(`--prompt-file only applies to \`mocactl spawn\`\n${help}`);
    return 2;
  }
  if (values.writable && values.workload === undefined) {
    io.err(`--writable needs --workload ID: only a workload's context is copied\n${help}`);
    return 2;
  }
  const workloadsCreate = command === 'workloads' && rest[0] === 'create';
  const createOnly = (['context', 'name', 'sandboxes', 'mount'] as const).find(
    (f) => values[f] !== undefined,
  );
  if (createOnly && !workloadsCreate) {
    io.err(`--${createOnly} only applies to \`mocactl workloads create\`\n${help}`);
    return 2;
  }
  // B14: refresh an expired API token once, up front, so every command's login check -- and the
  // interactive login screen -- sees the refreshed login rather than asking for a new one. `login`,
  // `logout` and `auth` manage the login themselves. `__spawn-worker` is the detached child of
  // `spawn`: it is handed its session token on stdin and does not need the user's API token or
  // refresh flow.
  if (
    rt.endpoints.controlPlaneUrl &&
    !['login', 'logout', 'auth', '__spawn-worker'].includes(command ?? '')
  ) {
    await ensureRuntimeAuth(rt);
  }
  switch (command) {
    case 'login': {
      const raw = values['test-user'];
      // A test-user login prints no device code, so it needs neither the clipboard nor the browser.
      if (raw === undefined) {
        return cmdLogin(rt, io, deps.signal, values['no-browser'] ? undefined : deps.loginHelpers);
      }
      // Validated before any network call, so a typo costs nothing and reports as usage.
      if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
        io.err(`--test-user needs a whole number from 1 (got ${JSON.stringify(raw)})\n${help}`);
        return 2;
      }
      return cmdLoginTestUser(rt, io, Number(raw), process.env);
    }
    case 'logout':
      if (rest.length > 0) return usage(io, help);
      return cmdLogout(rt, io, { all: values.all === true });
    case 'auth': {
      const [sub, ...extra] = rest;
      if (sub !== 'token')
        return sub === undefined ? usage(io, help) : unknown(io, 'auth', sub, help);
      if (extra.length > 0) return usage(io, help);
      return cmdAuthToken(rt, io, json);
    }
    case 'doctor':
      return cmdDoctor(rt, io, json);
    case 'run': {
      const prompt = rest.join(' ').trim();
      if (!prompt) {
        io.err(help);
        return 2;
      }
      // A new session is the default without --session; --new only says so explicitly.
      if (values.new && values.session !== undefined) {
        io.err(`--new and --session cannot be used together\n${help}`);
        return 2;
      }
      if (values.config !== undefined && values.session !== undefined) {
        io.err(
          `--config applies only to a new session; a session's bundle is fixed when it is created\n${help}`,
        );
        return 2;
      }
      if (values.config !== undefined && values.config.trim() === '') {
        io.err(`--config needs a bundle digest (sha256:…); omit it to run without one\n${help}`);
        return 2;
      }
      // Refused rather than ignored: --json already emits every tool_use and tool_result frame, so
      // --show-tools asks for nothing it does not have, and silently dropping a flag in a script is
      // worse than saying so (#419).
      if (values['show-tools'] === true && json) {
        io.err(`--show-tools is redundant with --json, which already streams tool frames\n${help}`);
        return 2;
      }
      let options: Record<string, string>;
      try {
        options = parseOptionFlags(values.option ?? []);
      } catch (err) {
        io.err((err as Error).message);
        return 2;
      }
      return cmdRun(rt, io, {
        prompt,
        session: values.session,
        options,
        json,
        signal: deps.signal,
        configRef: values.config,
        showTools: values['show-tools'] === true,
      });
    }
    case 'promote': {
      if (rest.length !== 1) return usage(io, help);
      return cmdPromote(rt, io, { dir: rest[0]!, json, dryRun: values['dry-run'] === true });
    }
    case 'bundles': {
      const [sub, digest, ...extra] = rest;
      if (sub === 'list') {
        // Takes no digest: the point of the listing is to find one (rossoctl/moca#559).
        if (digest !== undefined) return usage(io, help);
        return cmdBundleList(rt, io, { json, signal });
      }
      if (sub !== 'delete')
        return sub === undefined ? usage(io, help) : unknown(io, 'bundles', sub, help);
      if (digest === undefined || extra.length > 0) return usage(io, help);
      return cmdBundleDelete(rt, io, { digest, json, signal });
    }
    case 'sessions': {
      const [sub, id, ...extra] = rest;
      if (sub === undefined) return cmdSessions(rt, io, { json, signal });
      if (sub !== 'delete') return unknown(io, 'sessions', sub, help);
      if (id === undefined || extra.length > 0) return usage(io, help);
      return cmdSessionDelete(rt, io, { id, json, signal });
    }
    case 'credentials': {
      const [sub, name, ...extra] = rest;
      if (sub === undefined) return cmdCredentials(rt, io, { json, signal });
      if (sub !== 'add' && sub !== 'delete') return unknown(io, 'credentials', sub, help);
      if (name === undefined || extra.length > 0) return usage(io, help);
      if (sub === 'delete') return cmdCredentialDelete(rt, io, { name, json, signal });
      const { readStdin } = deps;
      if (!readStdin) {
        io.err('reading stdin is not wired yet');
        return 2;
      }
      return cmdCredentialAdd(rt, io, {
        name,
        // The TUI form's defaults.
        kind: values.kind ?? 'bearer',
        consumer: (values.consumer ?? 'inference') as CredentialConsumer,
        hosts: (values.host ?? [])
          .flatMap((h) => h.split(',').map((x) => x.trim()))
          .filter(Boolean),
        endpoint: values.endpoint,
        json,
        signal,
        readStdin,
        stdinIsTTY: deps.stdinIsTTY === true,
      });
    }
    case 'spawn': {
      const promptFile = values['prompt-file'];
      let prompt: string;
      if (promptFile !== undefined) {
        if (rest.length > 0) {
          io.err(`--prompt-file and an inline prompt cannot be used together\n${help}`);
          return 2;
        }
        // Open once, stat and read the same fd. O_NOFOLLOW refuses symlinks so a swapped
        // path cannot redirect the read elsewhere between stat and read (CodeQL CWE-367).
        // O_NONBLOCK keeps open() from parking on a FIFO with no writer; the isFile() check
        // then refuses it like any other non-regular file.
        let fd: number | undefined;
        try {
          fd = openSync(
            promptFile,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
          );
          const st = fstatSync(fd);
          if (!st.isFile()) {
            io.err(`--prompt-file: ${promptFile} is not a regular file`);
            return 2;
          }
          if (st.size > MAX_PROMPT_BYTES) {
            io.err(`--prompt-file: ${promptFile} is ${st.size} bytes; max is ${MAX_PROMPT_BYTES}`);
            return 2;
          }
          prompt = readFileSync(fd, 'utf8').trim();
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ELOOP') {
            io.err(`--prompt-file: ${promptFile} is a symlink; pass the target path`);
          } else {
            io.err(`--prompt-file: cannot read ${promptFile}: ${(err as Error).message}`);
          }
          return 2;
        } finally {
          // readFileSync(fd) leaves the fd open; close it on every exit path.
          if (fd !== undefined) closeSync(fd);
        }
        if (!prompt) {
          io.err(`--prompt-file: ${promptFile} has no prompt content (empty or whitespace-only)`);
          return 2;
        }
      } else {
        prompt = rest.join(' ').trim();
        if (!prompt) {
          io.err(`spawn needs a prompt\n${help}`);
          return 2;
        }
      }
      const kind = values.kind;
      if (kind !== 'prompt' && kind !== 'solve') {
        io.err(`--kind must be prompt or solve\n${help}`);
        return 2;
      }
      if (values.config !== undefined && values.config.trim() === '') {
        io.err(`--config needs a bundle digest (sha256:…); omit it to run without one\n${help}`);
        return 2;
      }
      const rawCap = values['max-concurrent'];
      let maxConcurrent: number | undefined;
      if (rawCap !== undefined) {
        if (!/^[1-9][0-9]{0,3}$/.test(rawCap)) {
          io.err(`--max-concurrent must be a whole number of at least 1\n${help}`);
          return 2;
        }
        maxConcurrent = Number(rawCap);
      }
      return cmdSpawn(rt, io, {
        prompt,
        kind,
        configRef: values.config,
        repoUrl: values.repo,
        ref: values.ref,
        tag: values.tag,
        label: values.label,
        workloadId: values.workload,
        writable: values.writable === true,
        async: values.async === true,
        requireApproval: values['require-approval'] === true,
        ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
        json,
      });
    }
    case 'subagents': {
      if (rest.length > 0) return usage(io, help);
      return cmdSubagents(rt, io, { tag: values.tag, json, signal });
    }
    case 'watch': {
      if (rest.length > 0) return usage(io, help);
      return cmdWatch(rt, io, { tag: values.tag, since: values.since, json, signal });
    }
    case 'get': {
      const [sid, ...extra] = rest;
      if (sid === undefined || extra.length > 0) return usage(io, help);
      let timeoutS: number | undefined;
      if (values.timeout !== undefined) {
        if (!/^[1-9][0-9]{0,4}$/.test(values.timeout)) {
          io.err(`--timeout must be a whole number of seconds, at least 1\n${help}`);
          return 2;
        }
        timeoutS = Number(values.timeout);
      }
      return cmdGet(rt, io, {
        sessionId: sid,
        outDir: values.out,
        wait: values.wait === true,
        ...(timeoutS !== undefined ? { timeoutS } : {}),
        json,
        signal,
      });
    }
    case 'follow-up': {
      const [sid, prompt, ...extra] = rest;
      if (sid === undefined || prompt === undefined || extra.length > 0) return usage(io, help);
      return cmdFollowUp(rt, io, {
        sessionId: sid,
        prompt,
        outDir: values.out,
        json,
        signal,
      });
    }
    case 'cancel': {
      const [sid, ...extra] = rest;
      if (sid === undefined || extra.length > 0) return usage(io, help);
      return cmdCancel(rt, io, { sessionId: sid, json });
    }
    case 'mcp': {
      if (rest.length > 0) return usage(io, help);
      // Nothing is printed: stdout is the protocol's, and a message on it would break the client.
      await serveSubagentMcp(rt, await stdioTransport(), { signal });
      return 0;
    }
    case 'approve':
    case 'reject': {
      const [sid, ...extra] = rest;
      if (sid === undefined || extra.length > 0) return usage(io, help);
      let gateId: number | undefined;
      if (values.gate !== undefined) {
        // Gate ids start at 0 and count up within a session, so `0` is a legitimate one.
        if (!/^(0|[1-9][0-9]{0,4})$/.test(values.gate)) {
          io.err(`--gate must be a whole gate number, as \`mocactl get\` reports it\n${help}`);
          return 2;
        }
        gateId = Number(values.gate);
      }
      return cmdDecide(rt, io, {
        sessionId: sid,
        action: command,
        ...(gateId !== undefined ? { gateId } : {}),
        ...(values.feedback !== undefined ? { feedback: values.feedback } : {}),
        json,
        signal,
      });
    }
    case 'workloads': {
      const [sub, id, ...extra] = rest;
      if (sub === undefined) {
        io.err(`mocactl workloads needs create, list, get or delete\n${help}`);
        return 2;
      }
      if (sub === 'list') {
        // Takes no id: the point of the listing is to find one (#552).
        if (id !== undefined) return usage(io, help);
        return cmdWorkloadList(rt, io, { json, signal });
      }
      if (sub === 'create') {
        if (id !== undefined) return usage(io, help);
        if (!values.context) {
          io.err(`workloads create needs --context FILE\n${help}`);
          return 2;
        }
        let sandboxes: number | undefined;
        if (values.sandboxes !== undefined) {
          sandboxes = /^[1-9][0-9]{0,3}$/.test(values.sandboxes)
            ? Number(values.sandboxes)
            : undefined;
          if (sandboxes === undefined) {
            io.err(`--sandboxes must be a whole number of at least 1\n${help}`);
            return 2;
          }
        }
        const mount = values.mount;
        if (mount !== undefined && !(WORKLOAD_MOUNTS as readonly string[]).includes(mount)) {
          io.err(`--mount must be read-only or writable\n${help}`);
          return 2;
        }
        return cmdWorkloadCreate(rt, io, {
          contextPath: values.context,
          name: values.name,
          ...(sandboxes !== undefined ? { sandboxes } : {}),
          ...(mount !== undefined ? { mount: mount as WorkloadMount } : {}),
          json,
          signal,
        });
      }
      if (sub !== 'get' && sub !== 'delete') return unknown(io, 'workloads', sub, help);
      if (id === undefined || extra.length > 0) return usage(io, help);
      return sub === 'get'
        ? cmdWorkloadGet(rt, io, { id, json, signal })
        : cmdWorkloadDelete(rt, io, { id, json, signal });
    }
    // Hidden entrypoint: the detached worker forked by `mocactl spawn` re-execs itself with this
    // subcommand, reads its payload from stdin, and writes the result to the ledger. Not in USAGE
    // because end users should never run it directly.
    case '__spawn-worker': {
      return runSpawnWorker(rt);
    }
    case 'harness':
      if (rest.length > 0) return usage(io, help);
      if (!deps.startInteractive) {
        io.err('interactive mode is not wired yet');
        return 2;
      }
      if (deps.stdinIsTTY === false) {
        io.err('the interactive UI needs a terminal; for scripts use `mocactl run "prompt"`');
        return 2;
      }
      return deps.startInteractive(rt, {
        setup: values.setup === true,
        noAnimation: values['no-animation'] === true,
      });
    default:
      io.err(`unknown command "${command}"\n${help}`);
      return 2;
  }
}
