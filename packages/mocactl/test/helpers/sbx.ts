import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LeaseControlError,
  type Exec,
  type ExecConnOptions,
  type LeaseEvent,
  type LeaseOpName,
  type LeaseStatusView,
} from '@moca/sandbox-client';
import { resolvePaths, saveAuth } from '../../src/config.js';
import { sbxMain, sbxPaths } from '../../src/sbx/cli.js';
import type { AgentopExec } from '../../src/sbx/agentop.js';
import type { ExecFactory } from '../../src/sbx/exec.js';

/** The fakes `mocactl sbx`'s tests share: a scripted control plane, a login, a sandbox, a token. */

export const URL_ = 'https://sbx-api.example.invalid';
export const SBX = 'sbx-0123456789abcdef0123456789';

export type Req = { method: string; path: string; body: unknown; auth?: string };
export type Handler = (
  req: Req,
) => { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A scripted control plane: one handler per "METHOD /path", recording every call. */
export function fakeCp(routes: Record<string, Handler>) {
  const calls: Req[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const req: Req = {
      method: init?.method ?? 'GET',
      path: u.pathname + u.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    };
    calls.push(req);
    const h = routes[`${req.method} ${u.pathname}`];
    if (!h) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const r = h(req);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const LOGIN = {
  apiToken: 'api-1',
  subject: 'github:1',
  roles: [],
  expiresAt: 4_000_000_000,
  controlPlaneUrl: URL_,
  refreshToken: 'mrt_x',
  refreshExpiresAt: 4_000_000_000,
};

export function setup(opts: { loggedIn?: boolean; expired?: boolean } = { loggedIn: true }) {
  const home = mkdtempSync(join(tmpdir(), 'mocactl-sbx-'));
  const env = { HOME: home, MOCACTL_SBX_URL: URL_ };
  const paths = resolvePaths(env, home);
  if (opts.loggedIn !== false) {
    // The sbx login lives in its own file (sbx-auth.json), never in MOCA's auth.json.
    saveAuth(sbxPaths(paths), { ...LOGIN, ...(opts.expired ? { expiresAt: 1_000 } : {}) });
  }
  // As main.ts wires it: text for mocactl's own messages, bytes for a remote command's output.
  const io = {
    outs: [] as string[],
    errs: [] as string[],
    outB: [] as Buffer[],
    errB: [] as Buffer[],
    out(s: string) {
      this.outs.push(s);
    },
    err(s: string) {
      this.errs.push(s);
    },
    outBytes(b: Uint8Array) {
      this.outB.push(Buffer.from(b));
    },
    errBytes(b: Uint8Array) {
      this.errB.push(Buffer.from(b));
    },
  };
  return { home, env, paths, io };
}

/** `GET /v1/policy`'s answer: the default policy (template-policy.ts DEFAULT_POLICY), its two profiles. */
export const policyView = (over: Record<string, unknown> = {}) => ({
  policy: {
    schema: 'moca-template-policy/1',
    profiles: {
      base: { requires: [], envelope: { maxGuestMb: 16_384, maxVcpus: 8, maxWorkspaceMb: 16_384 } },
      benchmark: {
        requires: ['X1', 'X10', 'X11', 'X12', 'X14', 'X15'],
        envelope: {
          maxGuestMb: 4096,
          maxVcpus: 2,
          maxWorkspaceMb: 8192,
          exact: { guestMb: 4096, vcpus: 2 },
        },
      },
    },
    defaultProfile: 'base',
    allowedRegistries: ['<default>'],
    trustedGateRecords: [],
    quota: { templates: 100, buildsQueued: 10, active: 8 },
    ...over,
  },
  digest: `sha256:${'d'.repeat(64)}`,
  record: `sha256:${'e'.repeat(64)}`,
});

/** A sandbox as the control plane returns it (`SbxSandbox`, loosely typed for scripted bodies). */
export type FakeSandbox = {
  id: string;
  owner: string;
  name: string | null;
  template: string;
  state: string;
  reason: string | null;
  createdAt: number;
  expiresAt: number;
  terminatedAt: number | null;
  labels: Record<string, string>;
  mode: string;
  idleTimeoutS: number;
  modeEpoch: number;
};
export const sandbox = (over: Record<string, unknown> = {}): FakeSandbox => ({
  id: SBX,
  owner: 'github:1',
  name: 'web',
  template: 'node22',
  state: 'ready',
  reason: null,
  createdAt: 1_800_000_000,
  expiresAt: 1_800_604_800,
  terminatedAt: null,
  labels: {},
  mode: 'per-exec',
  idleTimeoutS: 0,
  modeEpoch: 0,
  ...over,
});

/**
 * A fake connection's lease calls: every call recorded (`calls`), answered by `answer`. The default
 * answers each one `unavailable`, as a relay without lease calls would (the shared `NO_LEASE`).
 */
export function fakeLease(
  answer: (op: LeaseOpName, setModeToken?: string) => LeaseStatusView | Error = () =>
    new LeaseControlError('unavailable', 'this fake has no lease calls'),
) {
  const calls: { op: LeaseOpName; token?: string }[] = [];
  return {
    calls,
    leaseControl: async (op: LeaseOpName, setModeToken?: string): Promise<LeaseStatusView> => {
      calls.push({ op, ...(setModeToken !== undefined ? { token: setModeToken } : {}) });
      const a = answer(op, setModeToken);
      if (a instanceof Error) throw a;
      return a;
    },
    leaseKeepalive: async (): Promise<void> => {
      throw new LeaseControlError('unavailable', 'this fake has no lease calls');
    },
  };
}
/** The lease calls of a fake connection that does not use them: each answers `unavailable`. */
export const NO_LEASE = (({ leaseControl, leaseKeepalive }) => ({ leaseControl, leaseKeepalive }))(
  fakeLease(),
);

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** An unsigned JWT with the claims mocactl reads (unverified): `iat`, `exp` and `mode`. */
export const jwt = (claims: { iat: number; exp: number; mode?: string }) =>
  `${b64url({ alg: 'EdDSA', typ: 'JWT' })}.${b64url({ sbx: SBX, ...claims })}.sig`;

/** The token's lifetime is 900 s (`exp − iat`): the default timeout is 840 s. */
export const TOKEN_IAT = 1_800_000_000;
export const TOKEN = {
  token: jwt({ iat: TOKEN_IAT, exp: 1_800_000_900 }),
  expiresAt: 1_800_000_900,
  execEndpoint: 'sbx-exec.example.invalid:443',
  wrk: 'sbx_node22',
  wsk: SBX,
  execCa: null,
};

/**
 * Temp directories made by `tmp` (`localWorkspace` and `repo` included), removed by `cleanupTmp`
 * (afterEach).
 */
const made: string[] = [];
export function cleanupTmp(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}
export function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}

/**
 * The tools a sandbox Exec may need, linked into a bin directory of their own, so a test can take
 * one away (`without: ['tar']`: the Python fallback). `python3` is resolved to its real binary
 * (a pyenv shim needs pyenv on PATH).
 */
function toolDir(without: string[]): string {
  const bin = tmp('sbx-bin-');
  const tools = ['bash', 'sh', 'git', 'tar', 'gzip', 'find', 'rm', 'mkdir', 'mktemp', 'mv', 'head'];
  for (const t of [...tools, 'cat', 'wc', 'ls', 'env', 'dirname', 'basename', 'sed', 'tr']) {
    if (without.includes(t)) continue;
    const r = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' });
    if (r.status === 0) symlinkSync(r.stdout.trim(), join(bin, t));
  }
  if (!without.includes('python3')) {
    const r = spawnSync('python3', ['-c', 'import sys;print(sys.executable)'], {
      encoding: 'utf8',
    });
    if (r.status === 0) symlinkSync(r.stdout.trim(), join(bin, 'python3'));
  }
  return bin;
}

/**
 * A temp directory standing in for /workspace: each command runs in a real bash with `/workspace`
 * rewritten to it, as the worker would run it. `capBytes` cuts stdout as the worker's 8 MiB cap
 * does (`truncated`); `without` hides tools from PATH; `sent` records every command and stdin.
 */
export function localWorkspace(o: { capBytes?: number; without?: string[] } = {}) {
  const ws = tmp('sbx-ws-');
  const env = o.without?.length ? { ...process.env, PATH: toolDir(o.without) } : process.env;
  const sent: { command: string; stdin?: Buffer; timeoutS?: number }[] = [];
  const exec: Exec = (command, x = {}) =>
    new Promise((resolve) => {
      sent.push({
        command,
        ...(x.stdin ? { stdin: Buffer.from(x.stdin) } : {}),
        ...(x.timeoutS !== undefined ? { timeoutS: x.timeoutS } : {}),
      });
      const child = execFile(
        'bash',
        ['-c', command.replaceAll('/workspace', ws)],
        { encoding: 'buffer', maxBuffer: 512 << 20, env },
        (err, stdout, stderr) => {
          const code = err ? (err as { code?: unknown }).code : 0;
          const cut = o.capBytes !== undefined && stdout.length > o.capBytes;
          resolve({
            stdout: cut ? stdout.subarray(0, o.capBytes) : stdout,
            stderr,
            exitCode: typeof code === 'number' ? code : -1,
            truncated: cut,
            lease: [],
          });
        },
      );
      // A command that exits without reading its stdin closes the pipe: that EPIPE is not the test's.
      child.stdin!.on('error', () => {});
      child.stdin!.end(x.stdin ? Buffer.from(x.stdin) : undefined);
    });
  return { ws, exec, sent };
}

/** Runs git in `cwd`, returning stdout as text. */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

/**
 * A real repository with what a push must get right (plan 1c Review Focus 1): a space and unicode
 * in names, an executable, a symlink, a tracked file under a .gitignore'd directory, an ignored
 * file, an untracked file, and two untracked would-be secrets.
 */
export function repo(): string {
  const r = tmp('sbx-repo-');
  git(r, 'init', '-q');
  git(r, 'config', 'user.email', 't@example.invalid');
  git(r, 'config', 'user.name', 't');
  git(r, 'config', 'commit.gpgSign', 'false');
  mkdirSync(join(r, 'src'));
  writeFileSync(join(r, 'src/app.py'), 'print(1)\n');
  writeFileSync(join(r, '.gitignore'), 'build/\n');
  mkdirSync(join(r, 'build'));
  writeFileSync(join(r, 'build/keep.txt'), 'tracked under an ignored dir\n');
  writeFileSync(join(r, 'build/out.o'), 'ignored\n');
  mkdirSync(join(r, 'bin'));
  writeFileSync(join(r, 'bin/run.sh'), '#!/bin/sh\necho run\n');
  chmodSync(join(r, 'bin/run.sh'), 0o755);
  mkdirSync(join(r, 'dir with space'));
  writeFileSync(join(r, 'dir with space/ünï.txt'), 'u\n');
  symlinkSync('src/app.py', join(r, 'latest'));
  writeFileSync(join(r, '.env'), 'SECRET=1\n');
  writeFileSync(join(r, 'id_rsa'), 'key\n');
  git(r, 'add', 'src', '.gitignore', 'bin', 'dir with space', 'latest');
  git(r, 'add', '-f', 'build/keep.txt');
  git(r, 'commit', '-qm', 'init');
  writeFileSync(join(r, 'notes.md'), 'untracked, not ignored\n');
  return r;
}

/** `mocactl sbx up`'s world: a control plane, one workspace per sandbox, a real repository. */
export const OTHER = 'sbx-fedcba9876543210fedcba9876';
export const NEW = 'sbx-aaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * A control plane holding sandboxes: GET/list/create/token, every call recorded. `create` makes
 * NEW (then NEW2…); `tokens` counts mints per id.
 */
export function controlPlane(initial: ReturnType<typeof sandbox>[] = []) {
  const boxes = new Map<string, FakeSandbox>(initial.map((s) => [s.id, s]));
  let created = 0;
  const route = (key: string): Handler | undefined => {
    const [method, path] = key.split(' ') as [string, string];
    if (method === 'POST' && path === '/v1/sandboxes') {
      return (req) => {
        const b = req.body as { template: string; name?: string; labels?: Record<string, string> };
        const id = created++ === 0 ? NEW : `${NEW.slice(0, -1)}${created}`;
        const s = sandbox({
          id,
          template: b.template,
          name: b.name ?? null,
          labels: b.labels ?? {},
        });
        boxes.set(id, s);
        return { status: 201, body: s };
      };
    }
    if (method === 'GET' && path === '/v1/sandboxes') {
      return () => ({ status: 200, body: { sandboxes: [...boxes.values()] } });
    }
    const m = /^\/v1\/sandboxes\/([^/]+)(\/token)?$/.exec(path);
    if (!m) return undefined;
    const s = boxes.get(m[1]!);
    if (!s)
      return () => ({
        status: 404,
        body: { error: 'sandbox_not_found', message: 'no such sandbox' },
      });
    if (method === 'GET' && !m[2]) return () => ({ status: 200, body: s });
    if (method === 'DELETE' && !m[2]) {
      return () => {
        const reason: string = s.state === 'terminated' ? (s.reason ?? 'deleted') : 'deleted';
        boxes.set(s.id, { ...s, state: 'terminated', reason });
        return { status: 200, body: { id: s.id, state: 'terminated', reason } };
      };
    }
    if (method === 'POST' && m[2]) {
      return () =>
        s.state === 'ready'
          ? { status: 200, body: { ...TOKEN, wsk: s.id } }
          : {
              status: 409,
              body: { error: 'sandbox_terminated', message: 'sandbox expired', reason: s.reason },
            };
    }
    return undefined;
  };
  const cp = fakeCp(
    new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? route(k) : undefined) }),
  );
  return {
    ...cp,
    boxes,
    posts: () => cp.calls.filter((c) => c.method === 'POST' && c.path === '/v1/sandboxes'),
  };
}

/** One workspace per sandbox id, as the worker keeps them: the exec factory picks by `wsk`. */
export function workspaces(o: Parameters<typeof localWorkspace>[0] = {}) {
  const byId = new Map<string, ReturnType<typeof localWorkspace>>();
  const get = (id: string) => {
    if (!byId.has(id)) byId.set(id, localWorkspace(o));
    return byId.get(id)!;
  };
  let opened = 0;
  let closed = 0;
  const factory = (c: ExecConnOptions) => {
    opened++;
    return { exec: get(c.workspaceKey).exec, close: () => void closed++, ...NO_LEASE };
  };
  return { get, factory, counts: () => ({ opened, closed }) };
}

export function harness(
  o: {
    boxes?: ReturnType<typeof sandbox>[];
    ws?: Parameters<typeof localWorkspace>[0];
    /** Cortex's agentop, for `up --cortex` and doctor in Cortex mode (default: none on PATH). */
    agentop?: AgentopExec;
  } = {},
) {
  const s = setup();
  const cp = controlPlane(o.boxes);
  const ws = workspaces(o.ws);
  const r = repo();
  const agentop: AgentopExec =
    o.agentop ?? (async () => ({ code: null, stdout: '', stderr: 'agentop is not on PATH' }));
  const run = (argv: string[], over: { cwd?: string; env?: Record<string, string> } = {}) => {
    s.io.outs.length = 0;
    s.io.errs.length = 0;
    s.io.outB.length = 0;
    return sbxMain(argv, over.env ?? s.env, s.io, {
      home: s.home,
      fetchImpl: cp.fetchImpl,
      cwd: over.cwd ?? r,
      execFactory: ws.factory,
      agentop,
    });
  };
  const err = () => s.io.errs.join('\n');
  return { ...s, cp, ws, r, run, err };
}

/** A lease end as the worker sends it on an Exec's response (spec §5). */
export const leaseEnd = (over: Partial<LeaseEvent> = {}): LeaseEvent => ({
  reqId: 0,
  state: 'end',
  reason: 'idle',
  atUnixMs: 1_800_000_100_000,
  mode: 2, // SANDBOX_MODE_LEASE
  ageMs: 60_000,
  processes: [],
  endsByUnixMs: 0,
  tracked: [],
  ...over,
});

/**
 * `factory`'s connections, each Exec's result carrying the next entry of `queue` as its lease
 * events (none once it is empty), as a lease worker's responses do (spec §5).
 */
export function withLeaseEvents(factory: ExecFactory, queue: LeaseEvent[][]): ExecFactory {
  return (o) => {
    const c = factory(o);
    return {
      ...c,
      exec: async (command, opts) => {
        const r = await c.exec(command, opts);
        return { ...r, lease: queue.shift() ?? r.lease };
      },
    };
  };
}
