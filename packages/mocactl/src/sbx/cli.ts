import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { randomUUID } from 'node:crypto';
import {
  CALL_ID_RE,
  MAX_STDIN_BYTES,
  q,
  WORKSPACE,
  type SandboxModeName,
} from '@moca/sandbox-client';
import {
  loadAuth,
  loadConfig,
  normalizeUrl,
  resolvePaths,
  sameControlPlane,
  storedLoginUrl,
  type Paths,
  type TuiConfig,
} from '../config.js';
import { sanitizeRemote } from '../core/sanitize.js';
import type { Io, LoginHelpers } from '../headless.js';
import { buildRuntime, ensureRuntimeAuth, type Runtime } from '../runtime.js';
import { parseLifetime } from './lifetime.js';
import { SandboxApiClient, type SbxQuota, type SbxSandboxCreate } from './api.js';
import {
  cmdCreate,
  cmdEditTemplate,
  cmdEgress,
  cmdEnv,
  cmdLogin,
  cmdLogout,
  cmdLs,
  cmdRm,
  cmdSetQuota,
  cmdSubjectChange,
  cmdSubjects,
  cmdTagTemplate,
  cmdTemplates,
  cmdToken,
  cmdTransferTemplate,
  cmdUntagTemplate,
  failRefresh,
  resolveSandboxName,
  SANDBOX_NAME_RE,
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
import { commandUsage, typedWords } from '../core/usage.js';
import { isModeName, MODE_NAMES, modeRank, UPGRADE_NEEDS_TTY } from './mode.js';
import { cmdGet, cmdMode, cmdReset } from './lease-commands.js';
import { cmdProc, parseProcArgs, PROC_FLAG_OWNER, type ProcArgs } from './proc.js';

/**
 * What an sbx sandbox is, before the usage on `--help` and a bare `mocactl sbx` (#599): the plain
 * `mocactl harness` session's tools also run in "a sandbox", but one these commands never see, so a new
 * user needs the distinction before the command list. It defines the sandbox itself (made from a
 * template; no repository needed: `create`, then `run` and `put` by ID), then `up` as the
 * common way in, and says what the commands really do: `up`
 * and `push` copy the working tree once each (nothing syncs by itself), `up` writes the agent
 * configuration, and the agent's edits come back only through `pull`. Bob has no deny list, so its
 * local tools are said to stay. Not printed after a usage error, where it would only bury the error.
 */
export const SBX_ABOUT = `An sbx sandbox is a workspace on the sandbox service, made from a template, where your coding
agent's commands run in isolated VMs. In a git repository, \`mocactl sbx up\` creates or reuses one,
copies the working tree into its /workspace and points Claude Code, OpenCode and IBM Bob, in this
repository, at the sandbox's tools: their reads, edits and commands then run in the sandbox
service's VMs, not on this machine (Bob's local tools stay available: it has no deny list). Your
source files stay as they are, apart from the agent configuration \`up\` adds. The copy is not kept
in sync: \`mocactl sbx push\` sends later local edits, and \`mocactl sbx pull --apply\` applies the
agent's edits here as a patch. /workspace is kept between commands; the sandbox ends after a period
without use (7 days by default). Without a repository, \`mocactl sbx create\` makes one (from the
default template, or \`--template ID\`), and \`run\` and \`put\` use it by ID; \`proc\` needs one
made with \`--mode lease+processes\`. (A \`mocactl harness\` session's tools run in a sandbox of
moca's own server, SH_CONTROL_PLANE_URL: these commands do not see it.)`;

/**
 * The commands, grouped, each group in the order a user reaches for them (#599): the everyday
 * workflow first, from login to rm and logout, then the by-hand, credential, template and admin
 * commands.
 */
export const SBX_USAGE = `usage (the sandbox service):
a repository's sandbox, in the order you use it:
  mocactl sbx login [--control-plane-url URL] [--no-browser]
                                                 log in with the GitHub device flow
                                                 (--control-plane-url: the sandbox service's URL;
                                                 --no-browser: only print the sign-in URL and code)
  mocactl sbx up [--template T] [--name N] [--include-secrets] [--max-push MiB] [--max-file MiB]
                 [--no-agent-config] [--cortex] [--lifetime DURATION]
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
                                                 (--template: a new sandbox's template, default
                                                 'default'; a bound sandbox of another template is
                                                 refused, an unbound one is left and a new sandbox
                                                 created; matched by bare id, so ID:TAG or
                                                 ID@BUILD never reuses one; --name: a new
                                                 sandbox's name, as sbx create's (a second live
                                                 one of the name is refused; default: a made-up
                                                 adjective-surname); --include-secrets:
                                                 push .env*, *.pem, *.key and id_* files too;
                                                 --max-push: refuse a tree over MiB, default 256;
                                                 --max-file: refuse a file over MiB, default 12;
                                                 --no-agent-config:
                                                 write no agent configuration, only push and bind)
                                                 (--cortex: Cortex v0.9.3+ blocks the local tools
                                                 instead of a deny list, so Claude Code loads the
                                                 project's CLAUDE.md; kept by later runs)
                                                 (--lifetime: a new sandbox ends after DURATION
                                                 (36h, 14d, 90m or seconds; at least 1 h) without
                                                 use; default: the deployment's, 7 d; at most its
                                                 maximum, 30 d by default; a reused sandbox keeps
                                                 its own)
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
                                                 where Cortex blocks them. Auto-memory is off
                                                 in every mode (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)
  mocactl sbx codex [-- CODEX_ARGS ...]          run Codex CLI on this sandbox's MCP tools, for one
                                                 run (-c, nothing written: Codex reads no
                                                 project-local config, so up cannot configure it).
                                                 Its shell tool is off, but unified_exec cannot be
                                                 disabled, so local execution is restricted, not
                                                 denied: use Codex's own sandbox_mode as well
  mocactl sbx mcp [--sandbox SANDBOX]            the stdio MCP server for Claude Code / OpenCode
                                                 (--sandbox: the sandbox it serves)
  mocactl sbx run [--sandbox SANDBOX] [--timeout S] [-- CMD ...]   run CMD (or the script on stdin) in /workspace
                                                 (CMD's words are quoted, so they run exactly as typed:
                                                 for pipes, $VARS or globs use stdin or -- sh -c '...';
                                                 exit: the command's code; 124 timed out or killed;
                                                 125 sandbox failure; 75 refused before it started,
                                                 every try (retried MOCACTL_SBX_BUSY_RETRIES times,
                                                 default 4, at most 20; nothing ran); 130
                                                 interrupted; --timeout: S seconds, by default and
                                                 at most the sandbox token's lifetime minus 60 s;
                                                 --sandbox: the sandbox to run it in)
  mocactl sbx put PATH [--sandbox SANDBOX]       write stdin to PATH under /workspace
                                                 (a refusal before start: retried, 75, as run's;
                                                 --sandbox: the sandbox to write to)
  mocactl sbx pull [--apply] [-o FILE]           the sandbox's changes as a patch, on stdout or in
                                                 FILE (--apply: apply it here, then advance the
                                                 sandbox's baseline)
  mocactl sbx push [--force] [--include-secrets] [--max-push MiB] [--max-file MiB]
                                                 push the working tree again
                                                 (refused while the sandbox has changes not yet
                                                 pulled, unless --force; .env*, *.pem, *.key and
                                                 id_* stay behind unless --include-secrets;
                                                 --max-push: refuse a tree over MiB, default 256;
                                                 --max-file: refuse a file over MiB, default 12)
  mocactl sbx ls [--all] [--include-deleted] [--json]
                                                 your sandboxes (--all: everyone's; admins only;
                                                 --include-deleted: also those ended by sbx rm)
  mocactl sbx doctor [--sandbox SANDBOX] [--json]
                                                 check login, sandbox, agent config, exec and recent
                                                 calls (exit 0 when every check passes, else 1;
                                                 --sandbox: the sandbox to check)
  mocactl sbx rm [SANDBOX] [--keep-config] [--force] [--json]
                                                 delete a sandbox (its lease ended first); for the
                                                 bound one, also take back the agent configuration
                                                 sbx up added, and .sbx/ (unless --keep-config)
                                                 (refused while the sandbox has changes not yet
                                                 pulled, unless --force, or when that cannot be
                                                 checked)
  mocactl sbx logout                             end the sandbox-service login (deletes sbx-auth.json)

a sandbox by hand: create one, its lease and processes, a direct client:
  mocactl sbx create [--template ID[:TAG|@BUILD]] [--name N] [--label k=v ...] [--seed]
                     [--mode per-exec|lease|lease+processes] [--idle-timeout S] [--lifetime DURATION]
                     [--json]
                                                 create a sandbox; prints its id; --template: its
                                                 template, at a TAG or one BUILD (default: default,
                                                 at its default tag); --name: a name sbx ls shows
                                                 (a-z, 0-9 and -, not first; at most 63; unique
                                                 among your live sandboxes; default: a made-up
                                                 adjective-surname, such as eager-hopper);
                                                 --label: a key=value label (repeatable, at
                                                 most 16);
                                                 --seed: run the served build's seed, then check
                                                 /workspace is a clean tree (its HEAD becomes the
                                                 baseline pull and rm measure changes from);
                                                 --mode (default per-exec): a lease mode keeps the
                                                 guest between commands (the deployment must allow
                                                 it; an upgrade, so only from a terminal);
                                                 --idle-timeout: the lease ends after S idle
                                                 seconds (default: the worker's);
                                                 --lifetime: the sandbox ends after DURATION (36h,
                                                 14d, 90m or seconds; at least 1 h) without use
                                                 (default: the deployment's, 7 d; at most its
                                                 maximum, 30 d by default)
  mocactl sbx get [SANDBOX] [--json]             a sandbox's mode, epoch and idle timeout, and its
                                                 lease's state (a lease mode the worker has not
                                                 taken yet is sent again)
  mocactl sbx mode per-exec|lease|lease+processes [SANDBOX] [--idle-timeout S]
                                                 change the sandbox's mode (an upgrade only from a
                                                 terminal; --idle-timeout: the lease's S idle
                                                 seconds, kept unless given); a
                                                 worker that cannot be reached takes it at the next
                                                 command; a downgrade to per-exec ends the lease;
                                                 lease+processes to lease keeps it and stops the
                                                 tracked processes (it prints those it stopped)
  mocactl sbx reset [SANDBOX]                    end the sandbox's lease: the next command starts a
                                                 new guest (/tmp, installs outside /workspace and
                                                 background processes are gone)
  mocactl sbx proc start [--name N] [--cwd D] [SANDBOX] -- CMD ...
                                                 start CMD as a tracked process, which outlives the
                                                 command (lease+processes only; CMD quoted as run's;
                                                 --cwd: D, inside /workspace; --name: N, unique
                                                 among the running ones); prints its id, name and pid
  mocactl sbx proc ls [SANDBOX] [--json]         the tracked processes: id, name, pid, state
                                                 (running, exited(code) or killed(signal)), age and
                                                 memory; an exited one stays until the lease ends
  mocactl sbx proc logs (NAME|ID) [--tail N] [--raw] [SANDBOX]
                                                 the last N lines (--tail, default 200) of a tracked
                                                 process's stdout and stderr; on a terminal its
                                                 control sequences are removed (--raw keeps them;
                                                 piped output is always as written)
  mocactl sbx proc stop (NAME|ID) [--signal S] [SANDBOX]
                                                 send signal S (--signal, default TERM), then kill
                                                 what is left after 10 s; prints its final state
                                                 (the process: its name, or its id, p<n> or n; the
                                                 SANDBOX is the sandbox's)
  mocactl sbx token [SANDBOX] [--renew-every S] [--json]
                                                 print a fresh sandbox token (15 minutes by default);
                                                 --renew-every: a new line every S seconds until stopped
  mocactl sbx env [SANDBOX]                      shell exports for a direct sandbox/v1 client
  mocactl sbx egress [SANDBOX] [--json | --ndjson | --verify]
                                                 what the sandbox reached through its host's egress
                                                 proxy: per host, and whether the log is complete;
                                                 --ndjson prints the log whose sha256 its end record names;
                                                 --verify checks the log served against the control
                                                 plane's summary of it (sha256 and count; once the log
                                                 is sealed, at the host janitor's first sweep at least
                                                 10 minutes after the end, it is final)

the credentials the host swaps in:
  mocactl sbx credentials [list] [--json]       the credentials the host swaps into your sandboxes' HTTPS requests
  mocactl sbx credentials add NAME (--host DEST ... [--kind K] | --preset ID)
                                                 store one (the secret is read from stdin, never argv);
                                                 --host: where it is swapped in, DEST is
                                                 host[:port][/prefix] (repeatable); --kind: K is
                                                 bearer (default), basic, api-key, oauth2-token
                                                 (basic: stdin is username=... and password=...
                                                 lines); --preset: a preset's hosts and kind
                                                 instead (sbx credentials presets lists them; it
                                                 may also store NAME-<suffix> credentials)
  mocactl sbx credentials presets [--json]       the presets \`add --preset\` knows
  mocactl sbx credentials delete NAME            delete one

templates: what a sandbox is created from:
  mocactl sbx templates ls [--json]              the templates a sandbox can be created from, with
                                                 their readiness and tags
  mocactl sbx quota [--json]                     your template quotas and use, and your live-sandbox cap
  mocactl sbx policy [--json]                    the deployment's template policy: profiles (envelope,
                                                 egress, rules), allowed registries, quotas, digest
  mocactl sbx hosts [--json]                     per KVM host: active slots, start line, memory
                                                 headroom and floor, idle grace, disk
  mocactl sbx templates create --spec F [--spec F ...] [--id ID] [--image REF] [--profile P]
                               [--visibility private|deployment] [--gate-record F] [--dry-run]
                               [--timeout S] [--json]
                                                 create a template (or a new build of your own) from a
                                                 spec, or from a gate record's template block; --id
                                                 and --image (pinned by digest) default to the
                                                 spec's; --profile: the policy profile it must pass
                                                 (sbx policy; default: the policy's defaultProfile);
                                                 --visibility: a new template's, default deployment
                                                 (a self-attested one must be private: deployment
                                                 is refused);
                                                 --gate-record: F is the image's gate record (one
                                                 --spec, at most 1 MiB), sent byte for byte.
                                                 Several --spec: one create each. --timeout: S
                                                 seconds for all the creates together (default
                                                 3600) to wait for queue slots while your
                                                 buildsQueued quota is full; specs not yet sent
                                                 when it runs out are not sent. An id already
                                                 yours: a new build of it (the same inputs: that
                                                 build, reused).
                                                 --dry-run: reads the policy, then its checks that
                                                 need only the inputs; nothing created
  mocactl sbx templates build ID --spec F [--image REF] [--profile P] [--gate-record F] [--dry-run]
                               [--timeout S] [--json]
                                                 a new build of your template ID from the spec
                                                 --spec F (--image: default the spec's; --profile:
                                                 the policy profile it must pass; --gate-record:
                                                 the image's gate record; --dry-run: only the
                                                 checks, nothing built; --timeout: up to S seconds
                                                 waiting for a queue slot, default 3600)
  mocactl sbx templates show ID [--build BUILD] [--json]
                                                 a template and its builds (status, readiness, tags,
                                                 why a build failed), or, with --build, one build
                                                 with its spec (--json); BUILD is a build's handle
                                                 or build id, as this lists them
  mocactl sbx templates follow ID [--build BUILD] [--timeout S] [--json]
                                                 poll a build (--build; default: the newest) until
                                                 registered, failed, rejected or cancelled; exit 0
                                                 only on registered, 1 on any other end, 5 past S
                                                 seconds (--timeout, default 3600), 130 on Ctrl-C
                                                 (the build goes on)
  mocactl sbx templates cancel ID --build BUILD [--json]
                                                 withdraw a queued, building or probing build
                                                 (--build: which one)
  mocactl sbx templates tag ID TAG... --build BUILD [--json]
                                                 move tags onto a registered build (--build) of a
                                                 template you own; sandboxes made earlier keep
                                                 their build
  mocactl sbx templates untag ID TAG [--json]    remove a tag; its build stays (never default)
  mocactl sbx templates edit ID [--visibility private|deployment] [--description TEXT] [--json]
                                                 change who sees it (--visibility: private, only
                                                 you, others' sandboxes already made keep running;
                                                 deployment, everyone; refused for a template with
                                                 a self-attested build), or its description
                                                 (--description)
  mocactl sbx templates activate ID [--build BUILD] [--lease S] [--wait [--timeout S]] [--json]
                                                 take or renew your activation lease on a build (tag
                                                 default, or --build BUILD; --lease: S seconds,
                                                 60-86400); a host agent starts its worker. --wait:
                                                 until it is active, saying why it waits (queued at
                                                 N, no slot, memory); --timeout default 1800 s,
                                                 raised from the host's start line when queued
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
                                                 and every host has removed it (--timeout, default
                                                 900 s; exit 5 on a timeout), at once for a build no
                                                 host holds, or one whose worker a build neither
                                                 retired nor rejected uses

admins only:
  mocactl sbx templates transfer ID SUBJECT [--json]
                                                 make SUBJECT (github:<id> or oidc:<sub>) its owner
                                                 (admins only)
  mocactl sbx templates quota TARGET --templates N --builds-queued N --active N [--owned N] [--json]
  mocactl sbx templates quota TARGET --clear [--json]
                                                 set a subject's template quotas (--templates: the
                                                 templates it owns with a build registered or on
                                                 its way; --builds-queued: its builds queued,
                                                 building or probing at once; --active: the
                                                 templates it holds active at once) (TARGET
                                                 github:<numeric id> or oidc:<provider sub>) or the
                                                 default (TARGET default); --clear removes a
                                                 subject's override (admins only). --owned: the
                                                 template ids it may own in any status (without
                                                 it, the target keeps its current owned: to
                                                 return one subject's owned to the default,
                                                 --clear, then set the quota again). Reads, then
                                                 writes only if unchanged since the read: prints
                                                 old -> new; exit 1, nothing written, if another
                                                 admin changed it in between
  mocactl sbx admin subjects [--json]            every enrolled subject and its roles (admins only)
  mocactl sbx admin subjects enroll|unenroll SUBJECT [--json]
                                                 enroll SUBJECT (github:<id> or oidc:<sub>) or unenroll
                                                 one enrolled through the API (the settings' lists
                                                 stay; an admin named in the settings only)
  mocactl sbx admin subjects grant SUBJECT [--until DURATION|EPOCH] [--json]
  mocactl sbx admin subjects revoke SUBJECT [--json]
                                                 grant or revoke the admin role; --until (e.g. 30m, 2h,
                                                 1d, or epoch seconds; at most 365 days ahead) makes it
                                                 lapse by itself (each
                                                 change prints old -> new, and fails if the value
                                                 changed between its read and its write)
--record F (every command that calls the API but token, login, logout and credentials): one
NDJSON line per HTTP attempt appended to F (0600), with no token, host or free text in it.
Every command's sandbox commands are also recorded in the flight recorder,
<state dir>/sbx/<id>.log (0600): one line per attempt (req_id, start, ms, exit, outcome; never
the command or its output), per tool call for \`sbx mcp\`. MOCACTL_SBX_RUN_ID (optional) labels
them.
--json: print the result as JSON on stdout, for a script.
SANDBOX (or --sandbox SANDBOX) is a sandbox's id or its name (create's or up's --name; a name
that looks like an id is taken as one), and defaults to the sandbox in the nearest .sbx/sandbox.json. The control plane
comes from --control-plane-url, MOCACTL_SBX_URL, the bound sandbox's, the one remembered at
login, or the login's own (a login minted by an operator). \`up\` skips the bound sandbox's, and
rebinds, when this machine has a login for the remembered (or login's) one and none for it. The
login is kept apart from \`mocactl login\`'s, so both can be active at once.
exit: 0 ok, 1 failed, 2 usage, 3 log in first, 4 control plane unreachable, 5 a wait timed out,
130 interrupted (Ctrl-C)`;

/**
 * Each command's one line in the overview (bare `mocactl sbx`, `mocactl sbx --help`): what it
 * does, no flags. The flags and their meaning are `mocactl sbx COMMAND --help`, cut from SBX_USAGE.
 */
const SBX_SUMMARIES: Record<string, string> = {
  login: 'log in',
  up: "create or reuse this repository's sandbox and point your agents at it",
  claude: "run Claude Code on this sandbox's tools",
  codex: "run Codex CLI on this sandbox's tools",
  mcp: 'the stdio MCP server for your agent',
  run: 'run a command in /workspace',
  put: 'write a file under /workspace',
  pull: "the sandbox's changes as a patch, or applied here",
  push: 'send local edits to the sandbox',
  ls: 'list your sandboxes',
  doctor: 'check the login, sandbox, agent config and exec',
  rm: 'delete the sandbox and its agent config',
  logout: 'log out',
  create: 'create a sandbox from a template',
  get: "a sandbox's mode, idle timeout and lease",
  mode: "change a sandbox's mode",
  reset: "end a sandbox's lease",
  proc: 'start, list, read the logs of and stop tracked processes',
  token: 'print a sandbox token',
  env: 'shell exports for a direct sandbox/v1 client',
  egress: 'what a sandbox reached through its egress proxy',
  credentials: 'list, add or delete them',
  templates: 'list, create, build and manage templates',
  quota: 'your template quotas and live-sandbox cap',
  policy: "the deployment's template policy",
  hosts: 'per KVM host: slots, memory, disk',
  admin: 'enroll subjects, and grant or revoke the admin role',
};

/** SBX_USAGE's note on where the control plane comes from, for `login --help` and `logout --help`. */
const SBX_CONTROL_PLANE_NOTE = `The control plane comes from --control-plane-url, MOCACTL_SBX_URL, the bound sandbox's, the one
remembered at login, or the login's own (a login minted by an operator). The login is kept apart
from \`mocactl login\`'s, so both can be active at once.`;

/** Where the overview's descriptions start. */
const SBX_SUMMARY_COLUMN = 30;

/**
 * SBX_USAGE's groups, in its order, with one line per command (SBX_SUMMARIES) instead of every
 * form and flag. The admins' `templates transfer` and `quota` are in the templates line, so a
 * group left with no command of its own (none today) is dropped.
 */
function sbxOverview(): string {
  const head = '  mocactl sbx ';
  const out: string[] = ['usage (the sandbox service):'];
  const emitted = new Set<string>();
  let heading: string | undefined;
  for (const line of SBX_USAGE.split('\n').slice(1)) {
    if (line.startsWith(head)) {
      const word = /^[a-z][a-z+|-]*/.exec(line.slice(head.length))?.[0] ?? '';
      if (emitted.has(word)) continue;
      emitted.add(word);
      if (heading !== undefined) {
        if (out.length > 1) out.push('');
        out.push(heading);
        heading = undefined;
      }
      out.push(`${head}${word}`.padEnd(SBX_SUMMARY_COLUMN) + (SBX_SUMMARIES[word] ?? ''));
    } else if (line.endsWith(':') && !line.startsWith(' ')) {
      heading = line;
    } else if (!line.startsWith(' ') && line !== '') {
      break;
    }
  }
  out.push('', "Run `mocactl sbx COMMAND --help` for a command's flags and details.");
  return out.join('\n');
}

/** The commands SBX_OVERVIEW lists, in its order. */
export const SBX_COMMANDS = (): string[] =>
  [...SBX_OVERVIEW.matchAll(/^ {2}mocactl sbx (\S+)/gm)].map((m) => m[1]!);

/** `mocactl sbx` and `mocactl sbx --help`: every command, one line each, in SBX_USAGE's groups. */
export const SBX_OVERVIEW = sbxOverview();

/**
 * `mocactl sbx COMMAND [SUB...] --help`: that command's entries (commandUsage), then the notes that
 * apply to them. Undefined for a command with no entry, which then gets the whole usage. A usage
 * error (`forError`) leaves out the exit codes: the user just saw which one they got.
 */
function sbxCommandUsage(words: string[], opts: { forError?: boolean } = {}): string | undefined {
  const body = commandUsage(SBX_USAGE, '  mocactl sbx ', words);
  if (body === undefined) return undefined;
  const notes = [
    // A sandbox (`[SANDBOX]`, `--sandbox SANDBOX`), not `--id ID` or `--preset ID`.
    /\[SANDBOX\]|--sandbox SANDBOX/.test(body)
      ? "SANDBOX (or --sandbox SANDBOX) is a sandbox's id or its name, matched among your live\n" +
        'sandboxes, and defaults to the sandbox in the nearest .sbx/sandbox.json.'
      : undefined,
    /--json\b/.test(body) ? '--json: print the result as JSON on stdout, for a script.' : undefined,
    words[0] !== undefined && !NO_RECORD.has(words[0])
      ? '--record F: append one NDJSON line per HTTP attempt to F (0600), with no token, host or\n' +
        'free text in it.'
      : undefined,
    words[0] === 'login' || words[0] === 'logout' ? SBX_CONTROL_PLANE_NOTE : undefined,
    opts.forError
      ? undefined
      : 'exit codes: 0 ok, 1 failed, 2 usage error, 3 not logged in, 4 control plane unreachable,\n' +
        '5 a wait timed out, 130 stopped by Ctrl-C',
    'Run `mocactl sbx --help` for the list of all commands.',
  ].filter((l): l is string => l !== undefined);
  return `usage:\n${body}\n${notes.join('\n')}`;
}

export interface SbxDeps {
  signal?: AbortSignal;
  home?: string;
  fetchImpl?: typeof fetch;
  cwd?: string;
  /** Whether stdin is a terminal: `run` with no command then refuses rather than wait on it. */
  stdinIsTTY?: boolean;
  /** Whether stdout is a terminal: `proc logs` then removes control sequences (unless --raw). */
  stdoutIsTTY?: boolean;
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

function resolveSbxUrl(
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
function loginControlPlaneUrl(env: NodeJS.ProcessEnv, home: string): string | undefined {
  const u = storedLoginUrl(sbxPaths(resolvePaths(env, home)).authFile);
  return u && /^https?:\/\//.test(u) ? u : undefined;
}

/**
 * The control plane `up` uses instead of the binding's `boundUrl`: the one it would use without a
 * binding, when this machine has a login for it and none for `boundUrl`. Undefined otherwise, and
 * when the flag or MOCACTL_SBX_URL decides.
 */
function upFallbackUrl(
  boundUrl: string | undefined,
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  home: string,
): string | undefined {
  if (!boundUrl || flag || env.MOCACTL_SBX_URL) return undefined;
  const paths = resolvePaths(env, home);
  const url = resolveSbxUrl(
    undefined,
    env,
    loadConfig(paths).config,
    loginControlPlaneUrl(env, home),
  );
  const auth = sbxPaths(paths);
  return url && !loadAuth(auth, boundUrl) && loadAuth(auth, url) ? url : undefined;
}

/**
 * The sandbox control plane a bare `mocactl sbx` command would use, away from any bound sandbox:
 * MOCACTL_SBX_URL, then the one `sbx login` remembered, then the login file's own. `--version`
 * reports it.
 */
export function defaultSbxUrl(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string | undefined {
  return resolveSbxUrl(
    undefined,
    env,
    loadConfig(resolvePaths(env, home)).config,
    loginControlPlaneUrl(env, home),
  );
}

/** Where resolveSbxUrl's answer came from, by the same precedence (and the same `||`). */
function sbxUrlSource(
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
        ? `; that is not the control plane you logged in to (${sanitizeRemote(remembered.sbxControlPlaneUrl)}): log in there only if you trust it, as it would receive this repository's files` +
          (!loadAuth(rt.paths, url) && loadAuth(rt.paths, remembered.sbxControlPlaneUrl)
            ? ', or run `mocactl sbx up` to bind this repository to a sandbox there'
            : '')
        : '';
    io.err(`sbx: not logged in to the sandbox service${where}: run \`${login}\`${other}`);
    return SBX_EXIT.loginRequired;
  }
  if (auth.kind === 'unreachable') return failRefresh(io, auth.error, url);
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
/** The `templates` subcommands; their arguments are checked one by one in sbxMain (`quota`: one
 * TARGET). */
const TEMPLATE_SUBS = [
  'ls',
  'create',
  'build',
  'show',
  'follow',
  'cancel',
  ...TEMPLATE_ADMIN_SUBS,
  'activate',
  'deactivate',
  'retire',
  'quota',
];
/** The `templates` subcommands that take one template ID (`quota`: one TARGET). */
const TEMPLATE_ONE_ID = [
  'build',
  'show',
  'follow',
  'cancel',
  'edit',
  'activate',
  'deactivate',
  'retire',
  'quota',
];
/** The `templates` subcommands that take --build, and those that take --timeout (a wait; activate's
 * and retire's only with --wait). */
const TAKES_BUILD = ['show', 'follow', 'cancel', 'tag', 'activate', 'retire'];
const TAKES_TIMEOUT = ['follow', 'create', 'build', 'activate', 'retire'];
/** The commands that act on one sandbox: `[SANDBOX]` as an argument (or `--sandbox SANDBOX`). */
const TAKES_ID_ARG = new Set(['rm', 'token', 'env', 'get', 'reset', 'egress']);
/** The commands that act on one sandbox through `--sandbox SANDBOX` only. */
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
  'proc',
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
    | 'max-file'
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
    | 'lifetime'
  ),
  string[],
][] = [
  ['force', ['push', 'rm']],
  ['seed', ['create']],
  ['mode', ['create']],
  ['idle-timeout', ['create', 'mode']],
  ['lifetime', ['create', 'up']],
  ['include-secrets', ['up', 'push']],
  ['max-push', ['up', 'push']],
  ['max-file', ['up', 'push']],
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
/** `--max-push` and `--max-file` in MiB: up to 4 GiB, far above what a push should ever be. */
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

/**
 * `--lifetime DURATION`: `<n>m`, `<n>h`, `<n>d` or whole seconds; syntax only (the control plane's
 * 400 names the range). Undefined when absent; null, after saying why, when malformed.
 */
function parseLifetimeFlag(io: Io, raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = parseLifetime(raw.trim());
  if (n === undefined) {
    io.err(
      `sbx: --lifetime must be a duration such as 36h or 14d, or whole seconds (got '${sanitizeRemote(raw)}')`,
    );
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

/** `mocactl sbx`'s flags: one table, for the parse and for typedWords. */
const SBX_OPTIONS = {
  'control-plane-url': { type: 'string' },
  template: { type: 'string' },
  build: { type: 'string' },
  description: { type: 'string' },
  visibility: { type: 'string' },
  seed: { type: 'boolean' },
  mode: { type: 'string' },
  'idle-timeout': { type: 'string' },
  lifetime: { type: 'string' },
  name: { type: 'string' },
  cwd: { type: 'string' },
  tail: { type: 'string' },
  raw: { type: 'boolean' },
  signal: { type: 'string' },
  label: { type: 'string', multiple: true },
  all: { type: 'boolean' },
  'include-deleted': { type: 'boolean' },
  json: { type: 'boolean' },
  ndjson: { type: 'boolean' },
  verify: { type: 'boolean' },
  sandbox: { type: 'string' },
  timeout: { type: 'string' },
  lease: { type: 'string' },
  wait: { type: 'boolean' },
  reason: { type: 'string' },
  templates: { type: 'string' },
  'builds-queued': { type: 'string' },
  active: { type: 'string' },
  owned: { type: 'string' },
  clear: { type: 'boolean' },
  'stop-now': { type: 'boolean' },
  force: { type: 'boolean' },
  'include-secrets': { type: 'boolean' },
  'max-push': { type: 'string' },
  'max-file': { type: 'string' },
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
  until: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} satisfies ParseArgsConfig['options'];

async function sbxMainWith(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: SbxDeps,
  record: { recorder?: CallRecorder },
): Promise<number> {
  // A usage error shows the help of the command it is about (sbxCommandUsage), as --help does.
  const words = typedWords(argv, SBX_OPTIONS);
  const usage = sbxCommandUsage(words, { forError: true }) ?? SBX_OVERVIEW;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      // `proc start [SANDBOX] -- CMD`: where `--` was tells the sandbox from the command.
      tokens: true,
      options: SBX_OPTIONS,
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n${usage}`);
    return SBX_EXIT.usage;
  }
  const { values, positionals } = parsed;
  // The positionals after `--` (undefined without one): they are the tail of `positionals`.
  const dash = parsed.tokens.find((t) => t.kind === 'option-terminator');
  const afterDash = dash ? argv.slice(dash.index + 1) : undefined;
  const [command, arg, ...extra] = positionals;
  if (values.help) {
    // `sbx COMMAND --help`: that command's syntax, not every command's (the words before `--`).
    // Bare `sbx --help` opens with what an sbx sandbox is (#599).
    io.out((sbxCommandUsage(words) ?? `${SBX_ABOUT}\n\n${SBX_OVERVIEW}`) + '\n');
    return SBX_EXIT.ok;
  }
  if (!command) {
    io.err(`${SBX_ABOUT}\n\n${usage}`);
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
    'admin',
    'get',
    'mode',
    'reset',
    'proc',
  ];
  if (!known.includes(command)) {
    io.err(`sbx: unknown command '${command}'\n${usage}`);
    return SBX_EXIT.usage;
  }
  // These print no JSON (login and logout report on stderr, env prints shell exports), so a
  // --json would be silently ignored: refuse it rather than hand a script something it cannot parse.
  if (values.json && NO_JSON.has(command)) {
    io.err(`sbx: ${command} has no --json output\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.sandbox !== undefined && !TAKES_SANDBOX_FLAG.has(command)) {
    io.err(`sbx: --sandbox does not apply to ${command}\n${usage}`);
    return SBX_EXIT.usage;
  }
  if ((values.ndjson || values.verify) && command !== 'egress') {
    io.err(`sbx: --ndjson and --verify only apply to egress\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.ndjson && values.json) {
    io.err(`sbx: egress takes --json or --ndjson, not both\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.verify && values.ndjson) {
    io.err(`sbx: egress takes --ndjson or --verify, not both\n${usage}`);
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
      `sbx: --timeout only applies to run and templates ${TAKES_TIMEOUT.join(', ')}\n${usage}`,
    );
    return SBX_EXIT.usage;
  }
  const createFlag = (['spec', 'image', 'profile', 'gate-record', 'dry-run'] as const).find(
    (f) => values[f] !== undefined,
  );
  if (createFlag && !(sub === 'create' || sub === 'build')) {
    io.err(`sbx: --${createFlag} only applies to templates create and build\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.timeout !== undefined && (activating || retiring) && !values.wait) {
    io.err(`sbx: --timeout with templates ${sub} needs --wait\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.id !== undefined && sub !== 'create') {
    io.err(`sbx: --id only applies to templates create\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.visibility !== undefined && !(sub === 'create' || sub === 'edit')) {
    io.err(`sbx: --visibility only applies to templates create and edit\n${usage}`);
    return SBX_EXIT.usage;
  }
  if ((sub === 'create' || sub === 'build') && !values.spec?.length) {
    io.err(`sbx: templates ${sub} needs --spec F\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (sub === 'build' && (values.spec?.length ?? 0) > 1) {
    io.err(`sbx: templates build takes one --spec\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.lease !== undefined && !activating) {
    io.err(`sbx: --lease only applies to templates activate\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.wait !== undefined && !(activating || retiring)) {
    io.err(`sbx: --wait only applies to templates activate and templates retire\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.reason !== undefined && !retiring) {
    io.err(`sbx: --reason only applies to templates retire\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.reason !== undefined && values.build !== undefined) {
    io.err(
      `sbx: --reason is kept for a whole template's retire; retiring one build (--build) takes none\n${usage}`,
    );
    return SBX_EXIT.usage;
  }
  // `templates quota TARGET` (§5.2): the three limits, all of them, and owned if given, or --clear.
  const quotaFlags = (['templates', 'builds-queued', 'active', 'owned', 'clear'] as const).filter(
    (f) => values[f] !== undefined,
  );
  const settingQuota = command === 'templates' && arg === 'quota';
  if (quotaFlags.length > 0 && !settingQuota) {
    io.err(`sbx: --${quotaFlags[0]} only applies to templates quota\n${usage}`);
    return SBX_EXIT.usage;
  }
  let quotaBody: SbxQuota | null | undefined;
  if (settingQuota) {
    if (values.clear) {
      if (quotaFlags.length > 1) {
        io.err(`sbx: --clear takes no other quota flag\n${usage}`);
        return SBX_EXIT.usage;
      }
      if (extra[0] === 'default') {
        io.err(`sbx: the default quota is set, never cleared\n${usage}`);
        return SBX_EXIT.usage;
      }
      quotaBody = null;
    } else {
      const n = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : NaN);
      const q = {
        templates: n(values.templates),
        buildsQueued: n(values['builds-queued']),
        active: n(values.active),
      };
      if (![q.templates, q.buildsQueued, q.active].every(Number.isSafeInteger)) {
        io.err(
          `sbx: templates quota needs --templates, --builds-queued and --active (whole numbers), or --clear\n${usage}`,
        );
        return SBX_EXIT.usage;
      }
      const owned = values.owned === undefined ? undefined : n(values.owned);
      if (owned !== undefined && !Number.isSafeInteger(owned)) {
        io.err(`sbx: --owned must be a whole number\n${usage}`);
        return SBX_EXIT.usage;
      }
      quotaBody = owned === undefined ? q : { ...q, owned };
    }
  }
  if (values['stop-now'] !== undefined && !(command === 'templates' && arg === 'deactivate')) {
    io.err(`sbx: --stop-now only applies to templates deactivate\n${usage}`);
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
    io.err(`sbx: --${flagMisuse[0]} only applies to ${flagMisuse[1].join(' and ')}\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values['include-deleted'] !== undefined && command !== 'ls') {
    io.err(`sbx: --include-deleted only applies to ls\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.record !== undefined && NO_RECORD.has(command)) {
    io.err(`sbx: ${command} takes no --record (it would record a secret)\n${usage}`);
    return SBX_EXIT.usage;
  }
  const renewEvery = wholeSeconds(io, 'renew-every', values['renew-every']);
  if (renewEvery === null) return SBX_EXIT.usage;
  const credFlag = (['host', 'kind', 'preset'] as const).find((f) => values[f] !== undefined);
  if (credFlag && !(command === 'credentials' && arg === 'add')) {
    io.err(`sbx: --${credFlag} only applies to credentials add\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.cortex && values['no-agent-config']) {
    io.err(
      `sbx: --cortex is a choice about the agent configuration, which --no-agent-config does not write\n${usage}`,
    );
    return SBX_EXIT.usage;
  }
  if (values.template !== undefined && !values.template.trim()) {
    io.err(`sbx: --template needs a template id (see mocactl sbx templates ls)\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (
    (values.template !== undefined || (values.name !== undefined && command !== 'proc')) &&
    !['create', 'up'].includes(command)
  ) {
    io.err(`sbx: --template and --name only apply to create and up\n${usage}`);
    return SBX_EXIT.usage;
  }
  const procFlag = (['cwd', 'tail', 'raw', 'signal'] as const).find((f) => values[f] !== undefined);
  if (procFlag && command !== 'proc') {
    io.err(`sbx: --${procFlag} only applies to proc ${PROC_FLAG_OWNER[procFlag]}\n${usage}`);
    return SBX_EXIT.usage;
  }
  // `templates SUB ...` (template lifecycle spec §4), the owner's and admin's actions (§5.1-§5.2,
  // retire among them; quota TARGET: §5.2), and activate and deactivate (§6.3); `templates ls`
  // lists the templates.
  if (sub !== undefined && !TEMPLATE_SUBS.includes(sub)) {
    io.err(`sbx: unknown templates command '${sanitizeRemote(sub)}'\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (sub !== undefined && TEMPLATE_ADMIN_SUBS.includes(sub) && extra.some((x) => !x.trim())) {
    io.err(`sbx: templates ${sub} takes no empty argument\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (sub === 'ls' && extra.length > 0) {
    io.err(`sbx: templates ls takes no argument\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (sub === 'create' && extra.length > 0) {
    io.err(`sbx: templates create takes no ID (the spec names it, or --id)\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (
    sub !== undefined &&
    TEMPLATE_ONE_ID.includes(sub) &&
    (extra.length !== 1 || !extra[0]!.trim())
  ) {
    io.err(
      `sbx: templates ${sub} takes one ${sub === 'quota' ? 'TARGET (default or a subject)' : 'template ID'}\n${usage}`,
    );
    return SBX_EXIT.usage;
  }
  if ((sub === 'untag' || sub === 'transfer') && extra.length !== 2) {
    io.err(
      `sbx: templates ${sub} takes a template ID and ${sub === 'untag' ? 'a TAG' : 'a SUBJECT'}\n${usage}`,
    );
    return SBX_EXIT.usage;
  }
  if (sub === 'tag' && extra.length < 2) {
    io.err(`sbx: templates tag takes a template ID and at least one TAG\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.build !== undefined && !(sub !== undefined && TAKES_BUILD.includes(sub))) {
    io.err(`sbx: --build only applies to templates ${TAKES_BUILD.join(', ')}\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (sub === 'cancel' && values.build === undefined) {
    io.err(`sbx: templates cancel needs --build BUILD\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (sub === 'tag' && values.build === undefined) {
    io.err(`sbx: templates tag needs --build BUILD\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.description !== undefined && sub !== 'edit') {
    io.err(`sbx: --description only applies to templates edit\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (sub === 'edit' && values.visibility === undefined && values.description === undefined) {
    io.err(`sbx: templates edit needs --visibility or --description\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (
    sub === 'edit' &&
    values.visibility !== undefined &&
    values.visibility !== 'private' &&
    values.visibility !== 'deployment'
  ) {
    io.err(`sbx: --visibility must be private or deployment\n${usage}`);
    return SBX_EXIT.usage;
  }
  if (values.build !== undefined && !values.build.trim()) {
    io.err(`sbx: --build needs a build id (see mocactl sbx templates show ID)\n${usage}`);
    return SBX_EXIT.usage;
  }
  const subjectAction =
    command === 'admin' && arg === 'subjects' && extra.length > 0 ? extra[0] : undefined;
  if (values.until !== undefined && subjectAction !== 'grant') {
    io.err(`sbx: --until only applies to admin subjects grant\n${usage}`);
    return SBX_EXIT.usage;
  }
  let until: number | undefined;
  if (values.until !== undefined) {
    until = parseUntil(values.until, Math.floor(Date.now() / 1000));
    if (until === undefined) {
      io.err(
        `sbx: --until must be a duration (30m, 2h, 1d) or epoch seconds (not milliseconds) in the future, at most 365 days ahead (got '${sanitizeRemote(values.until)}')\n${usage}`,
      );
      return SBX_EXIT.usage;
    }
  }
  const sizes: Partial<Record<'max-push' | 'max-file', number>> = {};
  for (const flag of ['max-push', 'max-file'] as const) {
    if (values[flag] === undefined) continue;
    const raw = values[flag].trim();
    const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PUSH_MIB) {
      io.err(
        `sbx: --${flag} must be a whole number of MiB, 1 to ${MAX_PUSH_MIB} (got '${values[flag]}')`,
      );
      return SBX_EXIT.usage;
    }
    sizes[flag] = n * 2 ** 20;
  }
  const { 'max-push': maxPush, 'max-file': maxFile } = sizes;
  // Bare `templates` lists its subcommands, as bare `sbx` does, first pointing an old script or
  // habit (bare `templates` once listed the templates) at `templates ls`.
  if (command === 'templates' && arg === undefined) {
    io.err(
      `sbx: templates needs a subcommand; to list the templates, use 'mocactl sbx templates ls'\n${usage}`,
    );
    return SBX_EXIT.usage;
  }
  // `run` takes everything after the command (after `--`) as CMD; `put` exactly one PATH; rm, token,
  // env and egress at most one ID; every other command no argument at all.
  const argsOk =
    // run quotes its CMD; claude and codex forward their own flags and prompt to the child.
    command === 'run' ||
    // proc's arguments are its subcommand's: parseProcArgs checks them.
    command === 'proc' ||
    (command === 'templates' && arg !== undefined) ||
    command === 'claude' ||
    command === 'codex' ||
    (command === 'admin'
      ? arg === 'subjects' &&
        (extra.length === 0 ||
          (['enroll', 'unenroll', 'grant', 'revoke'].includes(extra[0]!) && extra.length === 2))
      : command === 'credentials'
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
      `sbx: ${command === 'put' ? 'put takes exactly one PATH' : `too many arguments for ${command}`}\n${usage}`,
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
    // A binding to a control plane this machine has no login for, while it has one for the
    // control plane it would otherwise use: `up` cannot reach the bound sandbox, so it uses
    // the logged-in control plane and rebinds, as `create` would.
    const other = upFallbackUrl(boundUrl, values['control-plane-url'], env, deps.home ?? homedir());
    if (other) {
      const was = sanitizeRemote(boundUrl!);
      const what = upBound ? `the bound sandbox ${sanitizeRemote(upBound)}` : '.sbx/sandbox.json';
      io.err(
        `sbx up: ${what} is on ${was}, which this machine is not logged in to; this ` +
          `repository's files go to ${sanitizeRemote(other)}, which it is (work not pulled ` +
          `from there stays on ${was})`,
      );
      boundUrl = undefined;
      upBound = undefined;
    }
    // The flag or MOCACTL_SBX_URL naming another control plane: the bound id is not on it.
    const chosen = values['control-plane-url'] || env.MOCACTL_SBX_URL;
    if (chosen && boundUrl && !sameControlPlane(chosen, boundUrl)) upBound = undefined;
  }
  let upLifetime: number | undefined;
  if (command === 'up') {
    const l = parseLifetimeFlag(io, values.lifetime);
    if (l === null) return SBX_EXIT.usage;
    upLifetime = l;
  }
  // `mode MODE [SANDBOX]`: the mode is checked before anything else is looked at.
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
  // `proc SUB ...`: its arguments, the sandbox among them, before anything else is looked at.
  let proc: ProcArgs | undefined;
  let procId: string | undefined;
  if (command === 'proc') {
    const head = positionals.slice(0, positionals.length - (afterDash?.length ?? 0));
    const r = parseProcArgs(head[1], head.slice(2), afterDash, values);
    if (typeof r === 'string') {
      io.err(`sbx: ${r}\n${usage}`);
      return SBX_EXIT.usage;
    }
    proc = r.args;
    procId = r.sandbox;
  }
  // `[SANDBOX]` as an argument: the one after the command, after `mode`'s MODE, or proc's.
  const idArg =
    command === 'mode'
      ? extra[0]
      : command === 'proc'
        ? procId
        : TAKES_ID_ARG.has(command)
          ? arg
          : undefined;
  // A sandbox named by its name rather than its id (an argument or --sandbox, never the binding,
  // which holds an id): looked up once the API is open. A name shaped like an id (`sbx-abc`) is
  // taken as the id.
  let byName: string | undefined;
  if (TAKES_SANDBOX_FLAG.has(command)) {
    id = idArg ?? values.sandbox;
    if (id !== undefined && !SANDBOX_ID_RE.test(id) && SANDBOX_NAME_RE.test(id)) {
      byName = id;
    }
    if (id === undefined) {
      const bound = readBinding(root ?? deps.cwd ?? process.cwd());
      id = bound?.id;
      boundUrl = bound?.controlPlaneUrl;
    }
    // No sandbox is one of doctor's failed checks (it says how to bind one), not a usage error.
    if (!id && command !== 'doctor') {
      io.err(
        TAKES_ID_ARG.has(command) || command === 'mode' || command === 'proc'
          ? `sbx: ${command} needs a sandbox id or name (or a .sbx/sandbox.json in this repository)`
          : `sbx: ${command} needs --sandbox SANDBOX (an id or name; or a .sbx/sandbox.json in this repository)`,
      );
      return SBX_EXIT.usage;
    }
    if (id !== undefined && byName === undefined && !SANDBOX_ID_RE.test(id)) {
      io.err(`sbx: '${sanitizeRemote(id)}' is not a sandbox id (sbx-…) or name`);
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
    const lifetime = parseLifetimeFlag(io, values.lifetime);
    if (lifetime === null) return SBX_EXIT.usage;
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
      ...(lifetime !== undefined ? { idleLifetimeS: lifetime } : {}),
    };
  }

  if (command === 'credentials') {
    // The catalog is local: no login, no request, no stdin.
    if (arg === 'presets') return listPresets({ io, json: values.json === true });
    if (arg === 'add' || arg === 'delete') {
      if (!extra[0]) {
        io.err(`sbx: credentials ${arg} needs a NAME\n${usage}`);
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
  // is opened (or refused) before the runtime's clients exist. Exec calls are gRPC: the flight
  // recorder has them (ctx.execRecord below), never this record.
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
      loginControlPlaneUrl(env, deps.home ?? homedir()),
    );
    deps = { ...deps, fetchImpl: r.wrap(deps.fetchImpl ?? fetch, base ?? 'http://invalid') };
  }
  const opened = await openSbx({ controlPlaneUrl: flagUrl }, env, io, deps, {
    login: OWN_LOGIN.has(command),
    ...(fromBinding ? { urlFrom: '.sbx/sandbox.json' } : {}),
  });
  if (typeof opened === 'number') return opened;
  // MOCACTL_SBX_RUN_ID: a caller's optional label on this command's records, never required; one
  // that is not an id is ignored (an agent's tools must not stop over a label), and said once.
  const runEnv = env.MOCACTL_SBX_RUN_ID;
  if (runEnv !== undefined && runEnv !== '' && !CALL_ID_RE.test(runEnv)) {
    io.err(`sbx: MOCACTL_SBX_RUN_ID is not an id (${CALL_ID_RE}); not recorded`);
  }
  const run = runEnv && CALL_ID_RE.test(runEnv) ? runEnv : undefined;
  const ctx: SbxCtx = {
    ...opened,
    io,
    json: values.json === true,
    signal: deps.signal,
    execRecord: {
      stateDir: opened.rt.paths.stateDir,
      command: `sbx ${command}`,
      invocation: record.recorder?.invocation ?? randomUUID(),
      ...(run !== undefined ? { run } : {}),
    },
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.random ? { random: deps.random } : {}),
  };
  if (byName !== undefined) {
    const found = await resolveSandboxName(ctx, byName);
    if (typeof found === 'number') return found;
    id = found;
  }
  // claude and codex pass an explicit sandbox on to the `sbx mcp` they start: as the id it resolved
  // to, which codex's TOML can carry only because an id needs no escaping.
  const sandboxFlag = values.sandbox !== undefined ? id : undefined;

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
      if (arg === 'quota') return cmdSetQuota(ctx, extra[0]!, quotaBody!);
      if (arg === 'retire')
        return cmdRetire(ctx, extra[0]!, {
          ...(values.build !== undefined ? { build: values.build } : {}),
          ...(values.reason !== undefined ? { reason: values.reason } : {}),
          wait: values.wait === true,
          ...(timeout !== undefined ? { timeoutS: timeout } : {}),
        });
      return cmdTemplates(ctx);
    case 'admin':
      if (extra.length === 0) return cmdSubjects(ctx);
      return cmdSubjectChange(
        ctx,
        extra[0] as 'enroll' | 'unenroll' | 'grant' | 'revoke',
        extra[1]!,
        until,
      );
    case 'hosts':
      return cmdHosts(ctx);
    case 'create':
      return cmdCreate(ctx, createBody!, {
        seed: values.seed === true,
        ...(deps.execFactory ? { factory: deps.execFactory } : {}),
      });
    case 'ls':
      return cmdLs(ctx, values.all === true, {
        includeDeleted: values['include-deleted'] === true,
      });
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
    case 'proc':
      return cmdProc(ctx, id!, proc!, deps.execFactory, { stdoutIsTTY: deps.stdoutIsTTY === true });
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
        sandboxFlag,
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
        sandboxFlag,
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
          ...(maxFile !== undefined ? { maxFile } : {}),
          ...(values.template ? { template: values.template } : {}),
          ...(values.name ? { name: values.name } : {}),
          ...(upLifetime !== undefined ? { idleLifetimeS: upLifetime } : {}),
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
          ...(maxFile !== undefined ? { maxFile } : {}),
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

/**
 * `--until` for `admin subjects grant`: a duration from now (`30m`, `2h`, `1d`) or
 * epoch seconds, in the future either way and at most 365 days ahead; undefined when it is
 * neither. The control plane's own bound is 366 days from ITS clock (so epoch milliseconds are
 * refused); a day less here leaves room for a client clock that runs ahead of the server's.
 */
const MAX_GRANT_SECONDS = 365 * 86_400;
export function parseUntil(raw: string, nowS: number): number | undefined {
  const d = /^([1-9][0-9]*)([mhd])$/.exec(raw);
  const n = d
    ? nowS + Number(d[1]) * { m: 60, h: 3600, d: 86_400 }[d[2] as 'm' | 'h' | 'd']
    : /^[1-9][0-9]*$/.test(raw)
      ? Number(raw)
      : Number.NaN;
  return Number.isSafeInteger(n) && n > nowS && n <= nowS + MAX_GRANT_SECONDS ? n : undefined;
}
