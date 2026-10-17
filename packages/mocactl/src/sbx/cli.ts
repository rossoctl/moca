import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, normalizeUrl, resolvePaths, type Paths, type TuiConfig } from '../config.js';
import type { Io } from '../headless.js';
import { buildRuntime, ensureRuntimeAuth, type Runtime } from '../runtime.js';
import { SandboxApiClient } from './api.js';
import {
  cmdCreate,
  cmdEnv,
  cmdLogin,
  cmdLs,
  cmdRm,
  cmdTemplates,
  cmdToken,
  failRefresh,
  SBX_EXIT,
  type RefreshFailure,
  type SbxCtx,
} from './commands.js';
import { readBoundSandbox, SANDBOX_ID_RE } from './state.js';

export const SBX_USAGE = `usage (the sandbox service, SBX0):
  mocactl sbx login [--control-plane-url URL]    log in with the GitHub device flow (the URL is remembered)
  mocactl sbx templates [--json]                 the templates a sandbox can be created from
  mocactl sbx create --template ID [--name N] [--label k=v ...] [--json]
                                                 create a sandbox; prints its id and expiry
  mocactl sbx ls [--all] [--json]                your sandboxes (--all: everyone's; admins only)
  mocactl sbx rm [ID] [--json]                   delete a sandbox
  mocactl sbx token [ID] [--json]                print a fresh sandbox token (15 minutes by default)
  mocactl sbx env [ID]                           shell exports for a direct sandbox/v1 client
ID defaults to the sandbox in the nearest .sbx/sandbox.json. The control plane comes from
--control-plane-url, MOCACTL_SBX_URL, or the one remembered at login. The login is kept apart
from \`mocactl login\`'s, so both can be active at once.
exit: 0 ok, 1 failed, 2 usage, 3 log in first, 4 control plane unreachable`;

export interface SbxDeps {
  signal?: AbortSignal;
  home?: string;
  fetchImpl?: typeof fetch;
  cwd?: string;
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

/** A runtime on the SANDBOX control plane: its own URL and its own login file. */
function open(
  url: string,
  env: NodeJS.ProcessEnv,
  deps: SbxDeps,
): { rt: Runtime; api: SandboxApiClient; refreshFailure: () => RefreshFailure | undefined } {
  const rt = buildRuntime(
    { controlPlaneUrl: url, harnessUrl: undefined },
    env,
    deps.home,
    deps.fetchImpl,
    { paths: sbxPaths },
  );
  // The client turns a failed retry into the original 401; what the refresh actually hit is kept
  // here so the command reports that instead of "log in again" (a network failure, not_enrolled).
  let lastFailure: RefreshFailure | undefined;
  const api = new SandboxApiClient(url, () => rt.auth?.apiToken, rt.fetchImpl, {
    label: hostname(),
    onTokenRejected: async () => {
      lastFailure = undefined;
      try {
        const r = await ensureRuntimeAuth(rt, { force: true });
        if (r.kind === 'unreachable') lastFailure = { error: r.error };
        return r.kind === 'ok';
      } catch (error) {
        lastFailure = { error };
        return false;
      }
    },
  });
  return { rt, api, refreshFailure: () => lastFailure };
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
  opts: { login?: boolean } = {},
): Promise<
  | {
      rt: Runtime;
      api: SandboxApiClient;
      url: string;
      explicitUrl?: string;
      refreshFailure: () => RefreshFailure | undefined;
    }
  | number
> {
  const remembered = loadConfig(resolvePaths(env, deps.home ?? homedir())).config;
  const url = resolveSbxUrl(flags.controlPlaneUrl, env, remembered);
  if (!url) {
    io.err('sbx: no sandbox control plane: pass --control-plane-url URL, or set MOCACTL_SBX_URL');
    return SBX_EXIT.usage;
  }
  const explicitUrl =
    sbxUrlSource(flags.controlPlaneUrl, env, remembered) === 'config' ? undefined : url;
  const opened = { ...open(url, env, deps), url, ...(explicitUrl ? { explicitUrl } : {}) };
  const { rt } = opened;
  if (opts.login) return opened;
  const auth = await ensureRuntimeAuth(rt);
  if (auth.kind === 'login_required') {
    io.err('sbx: not logged in to the sandbox service: run `mocactl sbx login`');
    return SBX_EXIT.loginRequired;
  }
  if (auth.kind === 'unreachable') return failRefresh(io, auth.error);
  return opened;
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
  const known = ['login', 'templates', 'create', 'ls', 'rm', 'token', 'env'];
  if (!known.includes(command)) {
    io.err(`sbx: unknown command '${command}'\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }
  const takesId = command === 'rm' || command === 'token' || command === 'env';
  if (extra.length > 0 || (arg !== undefined && !takesId)) {
    io.err(`sbx: too many arguments for ${command}\n${SBX_USAGE}`);
    return SBX_EXIT.usage;
  }

  // Everything checkable locally is checked before a request (or a refresh) is made.
  let id: string | undefined;
  if (takesId) {
    id = arg ?? readBoundSandbox(deps.cwd ?? process.cwd());
    if (!id) {
      io.err(`sbx: ${command} needs a sandbox id (or a .sbx/sandbox.json in this repository)`);
      return SBX_EXIT.usage;
    }
    if (!SANDBOX_ID_RE.test(id)) {
      io.err(`sbx: '${id}' is not a sandbox id (sbx-…)`);
      return SBX_EXIT.usage;
    }
  }
  let createBody: { template: string; name?: string; labels?: Record<string, string> } | undefined;
  if (command === 'create') {
    if (!values.template) {
      io.err(`sbx: create needs --template ID (see mocactl sbx templates)\n${SBX_USAGE}`);
      return SBX_EXIT.usage;
    }
    const labels = parseLabels(io, values.label ?? []);
    if (!labels) return SBX_EXIT.usage;
    createBody = {
      template: values.template,
      ...(values.name ? { name: values.name } : {}),
      ...(Object.keys(labels).length ? { labels } : {}),
    };
  }

  const opened = await openSbx({ controlPlaneUrl: values['control-plane-url'] }, env, io, deps, {
    login: command === 'login',
  });
  if (typeof opened === 'number') return opened;
  const ctx: SbxCtx = { ...opened, io, json: values.json === true, signal: deps.signal };

  switch (command) {
    case 'login':
      return cmdLogin(ctx, values['control-plane-url'] !== undefined);
    case 'templates':
      return cmdTemplates(ctx);
    case 'create':
      return cmdCreate(ctx, createBody!);
    case 'ls':
      return cmdLs(ctx, values.all === true);
    case 'rm':
      return cmdRm(ctx, id!);
    case 'token':
      return cmdToken(ctx, id!);
    default:
      return cmdEnv(ctx, id!);
  }
}
