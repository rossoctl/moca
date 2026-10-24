import { parseArgs } from 'node:util';
import { parseOptionFlags } from './core/session-options.js';
import type { CredentialConsumer } from './api/types.js';
import {
  cmdAuthToken,
  cmdBundleDelete,
  cmdCredentialAdd,
  cmdCredentialDelete,
  cmdCredentials,
  cmdDoctor,
  cmdLogin,
  cmdLogout,
  cmdPromote,
  cmdRun,
  cmdSessionDelete,
  cmdSessions,
  type Io,
} from './headless.js';
import { buildRuntime, ensureRuntimeAuth, type Runtime } from './runtime.js';
import { sbxMain } from './sbx/cli.js';
import { cmdGet, cmdSpawn, cmdSubagents, runSpawnWorker } from './subagent.js';
import { WORKLOAD_MOUNTS, type WorkloadMount } from './api/workloads.js';
import { cmdWorkloadCreate, cmdWorkloadDelete, cmdWorkloadGet } from './workloads.js';
import { VERSION } from './version.js';

export const USAGE = `usage:
  mocactl [--setup] [--no-animation]             interactive terminal UI
  mocactl --version                              print this build's version (a release tag, edge-<sha> or dev)
  mocactl login                                  log in with the GitHub device flow
  mocactl logout [--all]                         end this login (--all: every login of yours)
  mocactl auth token [--json]                    print a valid API token, refreshing if needed
                                                 (exit 3: log in first; 4: control plane unreachable)
  mocactl doctor [--json]                        check the setup; one fix per failure
  mocactl run "prompt" [--session ID | --new] [--option key=value ...] [--json]
  mocactl run "prompt" --config DIGEST            start the new session with a promoted config bundle
  mocactl promote DIR [--dry-run] [--json]       upload DIR's .claude/skills and .claude/commands
                                                 (--dry-run: build and report, upload nothing)
  mocactl bundles delete DIGEST [--json]         delete a bundle you promoted and free its budget
  mocactl sbx …                                  the sandbox service: login, create, ls, rm, token, env (mocactl sbx --help)
  mocactl sessions [--json]                      list your sessions
  mocactl sessions delete ID [--json]
  mocactl credentials [--json]                   list your credentials (never their secrets)
  mocactl credentials add NAME --host HOST [--host HOST ...] [--kind KIND] [--consumer CONSUMER]
      [--endpoint URL] [--json]                  the secret is read from stdin
  mocactl credentials delete NAME [--json]
  mocactl spawn "prompt" [--config DIGEST] --kind prompt|solve
      [--repo URL --ref REF] [--tag T] [--label L] [--json]
                                                 fork a detached subagent (solve needs --repo/--ref;
                                                 --label names one dispatch within a --tag group,
                                                 surfaced on 'mocactl subagents --json' as label)
  mocactl spawn "prompt" --kind prompt --workload ID [--writable] [...]
                                                 run the subagent on a workload's context
                                                 (--writable: its own copy, discarded after)
  mocactl subagents [--tag T] [--json]            list spawned subagents + current state
  mocactl get SESSIONID [--out DIR] [--json]      write result files + bounded summary
  mocactl workloads create --context FILE [--name NAME] [--json]
      [--sandboxes N [--mount read-only|writable]]
                                                 upload a context file (contextctl ctx pack) to a
                                                 new workload; prints its id (--sandboxes: N
                                                 sandboxes of its own; --mount: its context on
                                                 their own volume, no per-run copy)
  mocactl workloads get ID [--json]
  mocactl workloads delete ID [--json]           delete a workload and its context
flags for every command: --control-plane-url URL
  (the control plane says where the harness is; --harness-url URL overrides that)`;

const CREDENTIAL_FLAGS = ['kind', 'consumer', 'host', 'endpoint'] as const;

function usage(io: Io): number {
  io.err(USAGE);
  return 2;
}

function unknown(io: Io, command: string, sub: string): number {
  io.err(`unknown ${command} command "${sub}"\n${USAGE}`);
  return 2;
}

export interface InteractiveOptions {
  setup: boolean;
  noAnimation: boolean;
}

export type StartInteractive = (rt: Runtime, opts: InteractiveOptions) => Promise<number>;

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: {
    buildRuntime?: typeof buildRuntime;
    startInteractive?: StartInteractive;
    signal?: AbortSignal;
    /**
     * Whether stdin is a terminal; Ink needs raw mode, so the interactive UI refuses without one,
     * and `credentials add` wants its secret piped.
     */
    stdinIsTTY?: boolean;
    /** All of stdin; `credentials add` reads its secret from it, `sbx run` its script. */
    readStdin?: () => Promise<string>;
    /** All of stdin, byte for byte (at least `limit` bytes when given): `sbx put`'s content. */
    readStdinBytes?: (limit?: number) => Promise<Buffer>;
  } = {},
): Promise<number> {
  // `mocactl sbx` (SBX0) is its own command group with its own flags and its own control plane, so
  // it is dispatched before the global flag table rather than widening it.
  if (argv[0] === 'sbx') {
    return sbxMain(argv.slice(1), env, io, {
      signal: deps.signal,
      stdinIsTTY: deps.stdinIsTTY,
      readStdin: deps.readStdin,
      readStdinBytes: deps.readStdinBytes,
    });
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'control-plane-url': { type: 'string' },
        'harness-url': { type: 'string' },
        session: { type: 'string' },
        new: { type: 'boolean' },
        option: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        kind: { type: 'string' },
        consumer: { type: 'string' },
        host: { type: 'string', multiple: true },
        endpoint: { type: 'string' },
        config: { type: 'string' },
        all: { type: 'boolean' },
        setup: { type: 'boolean' },
        'no-animation': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        repo: { type: 'string' },
        ref: { type: 'string' },
        tag: { type: 'string' },
        label: { type: 'string' },
        out: { type: 'string' },
        workload: { type: 'string' },
        writable: { type: 'boolean' },
        context: { type: 'string' },
        name: { type: 'string' },
        sandboxes: { type: 'string' },
        mount: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.out(VERSION + '\n');
    return 0;
  }
  if (values.help) {
    io.out(USAGE + '\n');
    return 0;
  }

  const rt = (deps.buildRuntime ?? buildRuntime)(
    { controlPlaneUrl: values['control-plane-url'], harnessUrl: values['harness-url'] },
    env,
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
      io.err(`--${stray} only applies to \`mocactl credentials add\`\n${USAGE}`);
      return 2;
    }
  }
  if (values.config !== undefined && command !== 'run' && command !== 'spawn') {
    io.err(`--config only applies to \`mocactl run\` and \`mocactl spawn\`\n${USAGE}`);
    return 2;
  }
  if (values.all !== undefined && command !== 'logout') {
    io.err(`--all only applies to \`mocactl logout\`\n${USAGE}`);
    return 2;
  }
  if ((values.repo !== undefined || values.ref !== undefined) && command !== 'spawn') {
    io.err(`--repo and --ref only apply to \`mocactl spawn\`\n${USAGE}`);
    return 2;
  }
  if (values.tag !== undefined && command !== 'spawn' && command !== 'subagents') {
    io.err(`--tag only applies to \`mocactl spawn\` and \`mocactl subagents\`\n${USAGE}`);
    return 2;
  }
  if (values.label !== undefined && command !== 'spawn') {
    io.err(`--label only applies to \`mocactl spawn\`\n${USAGE}`);
    return 2;
  }
  if (values.out !== undefined && command !== 'get') {
    io.err(`--out only applies to \`mocactl get\`\n${USAGE}`);
    return 2;
  }
  if (values.workload !== undefined && command !== 'spawn') {
    io.err(`--workload only applies to \`mocactl spawn\`\n${USAGE}`);
    return 2;
  }
  if (values.writable !== undefined && command !== 'spawn') {
    io.err(`--writable only applies to \`mocactl spawn\`\n${USAGE}`);
    return 2;
  }
  if (values.writable && values.workload === undefined) {
    io.err(`--writable needs --workload ID: only a workload's context is copied\n${USAGE}`);
    return 2;
  }
  const workloadsCreate = command === 'workloads' && rest[0] === 'create';
  const createOnly = (['context', 'name', 'sandboxes', 'mount'] as const).find(
    (f) => values[f] !== undefined,
  );
  if (createOnly && !workloadsCreate) {
    io.err(`--${createOnly} only applies to \`mocactl workloads create\`\n${USAGE}`);
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
    case 'login':
      return cmdLogin(rt, io, deps.signal);
    case 'logout':
      if (rest.length > 0) return usage(io);
      return cmdLogout(rt, io, { all: values.all === true });
    case 'auth': {
      const [sub, ...extra] = rest;
      if (sub !== 'token') return sub === undefined ? usage(io) : unknown(io, 'auth', sub);
      if (extra.length > 0) return usage(io);
      return cmdAuthToken(rt, io, json);
    }
    case 'doctor':
      return cmdDoctor(rt, io, json);
    case 'run': {
      const prompt = rest.join(' ').trim();
      if (!prompt) {
        io.err(USAGE);
        return 2;
      }
      // A new session is the default without --session; --new only says so explicitly.
      if (values.new && values.session !== undefined) {
        io.err(`--new and --session cannot be used together\n${USAGE}`);
        return 2;
      }
      if (values.config !== undefined && values.session !== undefined) {
        io.err(
          `--config applies only to a new session; a session's bundle is fixed when it is created\n${USAGE}`,
        );
        return 2;
      }
      if (values.config !== undefined && values.config.trim() === '') {
        io.err(`--config needs a bundle digest (sha256:…); omit it to run without one\n${USAGE}`);
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
      });
    }
    case 'promote': {
      if (rest.length !== 1) return usage(io);
      return cmdPromote(rt, io, { dir: rest[0]!, json, dryRun: values['dry-run'] === true });
    }
    case 'bundles': {
      const [sub, digest, ...extra] = rest;
      if (sub !== 'delete') return sub === undefined ? usage(io) : unknown(io, 'bundles', sub);
      if (digest === undefined || extra.length > 0) return usage(io);
      return cmdBundleDelete(rt, io, { digest, json, signal });
    }
    case 'sessions': {
      const [sub, id, ...extra] = rest;
      if (sub === undefined) return cmdSessions(rt, io, { json, signal });
      if (sub !== 'delete') return unknown(io, 'sessions', sub);
      if (id === undefined || extra.length > 0) return usage(io);
      return cmdSessionDelete(rt, io, { id, json, signal });
    }
    case 'credentials': {
      const [sub, name, ...extra] = rest;
      if (sub === undefined) return cmdCredentials(rt, io, { json, signal });
      if (sub !== 'add' && sub !== 'delete') return unknown(io, 'credentials', sub);
      if (name === undefined || extra.length > 0) return usage(io);
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
      const prompt = rest.join(' ').trim();
      if (!prompt) {
        io.err(`spawn needs a prompt\n${USAGE}`);
        return 2;
      }
      const kind = values.kind;
      if (kind !== 'prompt' && kind !== 'solve') {
        io.err(`--kind must be prompt or solve\n${USAGE}`);
        return 2;
      }
      if (values.config !== undefined && values.config.trim() === '') {
        io.err(`--config needs a bundle digest (sha256:…); omit it to run without one\n${USAGE}`);
        return 2;
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
        json,
      });
    }
    case 'subagents': {
      if (rest.length > 0) return usage(io);
      return cmdSubagents(rt, io, { tag: values.tag, json, signal });
    }
    case 'get': {
      const [sid, ...extra] = rest;
      if (sid === undefined || extra.length > 0) return usage(io);
      return cmdGet(rt, io, { sessionId: sid, outDir: values.out, json, signal });
    }
    case 'workloads': {
      const [sub, id, ...extra] = rest;
      if (sub === undefined) {
        // The harness has no route that lists workloads.
        io.err(`mocactl workloads needs create, get or delete (there is no list)\n${USAGE}`);
        return 2;
      }
      if (sub === 'create') {
        if (id !== undefined) return usage(io);
        if (!values.context) {
          io.err(`workloads create needs --context FILE\n${USAGE}`);
          return 2;
        }
        let sandboxes: number | undefined;
        if (values.sandboxes !== undefined) {
          sandboxes = /^[1-9][0-9]{0,3}$/.test(values.sandboxes)
            ? Number(values.sandboxes)
            : undefined;
          if (sandboxes === undefined) {
            io.err(`--sandboxes must be a whole number of at least 1\n${USAGE}`);
            return 2;
          }
        }
        const mount = values.mount;
        if (mount !== undefined && !(WORKLOAD_MOUNTS as readonly string[]).includes(mount)) {
          io.err(`--mount must be read-only or writable\n${USAGE}`);
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
      if (sub !== 'get' && sub !== 'delete') return unknown(io, 'workloads', sub);
      if (id === undefined || extra.length > 0) return usage(io);
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
    case undefined:
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
      io.err(`unknown command "${command}"\n${USAGE}`);
      return 2;
  }
}
