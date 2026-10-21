import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdSpawn, type SpawnOptions } from '../src/subagent.js';
import { openLedger } from '../src/core/subagent-ledger.js';
import type { Ledger } from '../src/core/subagent-ledger.js';
import type { LeafEnvelope } from '../src/transport/leaf-turn.js';
import { ApiError } from '../src/api/errors.js';

/* --- test harness: minimal Runtime + Io, fake control plane --- */

const DIGEST = 'sha256:' + 'a'.repeat(64);

function makeRt(): any {
  const createdSessions: Array<{ configRef?: string }> = [];
  const cp = {
    createSession: vi.fn(async (req: { configRef?: string }) => {
      createdSessions.push(req);
      return { sessionId: 'sess-abc', token: 'tok-xyz', expiresAt: 0 };
    }),
    mintSessionToken: vi.fn(),
    // Unused by cmdSpawn; kept here so the Runtime typecheck passes.
    healthz: vi.fn(),
  };
  const harness = {
    baseUrl: vi.fn(async () => 'https://harness.test'),
  };
  return {
    rt: {
      cp,
      harness,
      auth: { subject: 'alice', apiToken: 'api-tok', expiresAt: 999 },
      paths: { stateDir: '/tmp', subagentsFile: '/tmp/subagents.jsonl' },
      now: () => 1_000_000,
      fetchImpl: fetch,
    },
    createdSessions,
    cp,
  };
}

function makeIo(): {
  io: { out: (s: string) => void; err: (s: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

let scratch: string;
let ledgerPath: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'spawn-'));
  ledgerPath = join(scratch, 'subagents.jsonl');
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function withLedger(rt: any): Ledger {
  rt.paths = { ...rt.paths, stateDir: scratch, subagentsFile: ledgerPath };
  return openLedger(ledgerPath);
}

const workloadsReturning = (status: string) => ({
  get: vi.fn(async (id: string) => ({ workloadId: id, status })),
});

const baseOpts = (over: Partial<SpawnOptions> = {}): SpawnOptions => ({
  prompt: 'summarize the repo',
  kind: 'prompt',
  json: false,
  // The --workload preflight finds every workload ready unless a test says otherwise.
  workloads: workloadsReturning('ready'),
  ...over,
});

/* --- flag validation --- */

describe('cmdSpawn — flag validation refuses before any session is created', () => {
  it('refuses a bundle that is not sha256:<64 hex>', async () => {
    const { rt, cp } = makeRt();
    const { io, err } = makeIo();
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({ configRef: 'not-a-digest', forkFn: () => 1, ledger: withLedger(rt) }),
    );
    expect(r).toBe(2);
    expect(cp.createSession).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('bundle digest is sha256:');
  });

  it('refuses solve without --repo and --ref (both required)', async () => {
    const { rt, cp } = makeRt();
    const { io, err } = makeIo();
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({ kind: 'solve', repoUrl: 'https://x', forkFn: () => 1, ledger: withLedger(rt) }),
    );
    expect(r).toBe(2);
    expect(cp.createSession).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('--kind solve needs both');
  });

  it('refuses --repo/--ref on prompt kind (would be silently ignored otherwise)', async () => {
    const { rt, cp } = makeRt();
    const { io, err } = makeIo();
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({ repoUrl: 'https://x', ref: 'main', forkFn: () => 1, ledger: withLedger(rt) }),
    );
    expect(r).toBe(2);
    expect(cp.createSession).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('--repo and --ref are only meaningful');
  });

  it('refuses an empty-after-trim prompt (an empty prompt would spawn a bare agent)', async () => {
    const { rt, cp } = makeRt();
    const { io } = makeIo();
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({ prompt: '   ', forkFn: () => 1, ledger: withLedger(rt) }),
    );
    expect(r).toBe(2);
    expect(cp.createSession).not.toHaveBeenCalled();
  });

  it('refuses a label outside [A-Za-z0-9][A-Za-z0-9._-]{0,63} (empty, spaces, leading dot, >64 chars)', async () => {
    const { rt, cp } = makeRt();
    const long = 'a' + 'b'.repeat(64); // 65 chars
    for (const bad of ['', 'has spaces!', '.hidden', long]) {
      const { io, err } = makeIo();
      const r = await cmdSpawn(
        rt,
        io,
        baseOpts({ label: bad, forkFn: () => 1, ledger: withLedger(rt) }),
      );
      expect(r).toBe(2);
      expect(err.join('\n')).toContain('[A-Za-z0-9._-]');
    }
    expect(cp.createSession).not.toHaveBeenCalled();
  });
});

describe('cmdSpawn — --label', () => {
  it('persists label on the ledger row (absent-when-omitted is covered in subagent-list.test)', async () => {
    const { rt } = makeRt();
    await cmdSpawn(
      rt,
      makeIo().io,
      baseOpts({ label: 'diagnose', forkFn: () => 4242, ledger: withLedger(rt) }),
    );
    expect(openLedger(ledgerPath).readAll()[0]!.label).toBe('diagnose');
  });
});

/* --- happy path --- */

describe('cmdSpawn — happy path', () => {
  it('with --config, creates the session, writes the ledger record before fork, then updates pid', async () => {
    const { rt, cp, createdSessions } = makeRt();
    const ledger = withLedger(rt);
    const { io, out, err } = makeIo();
    const seenAtFork: LedgerRecord[] | undefined = undefined;
    const forkFn = vi.fn((_sid: string, _tok: string, _env: LeafEnvelope, _cwd: string): number => {
      // The ledger record must exist at the moment of fork (per the "record before fork" invariant).
      const snapshot = openLedger(ledgerPath).readAll();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]!.sessionId).toBe('sess-abc');
      expect(snapshot[0]!.childPid).toBeUndefined(); // pid is set AFTER fork returns
      return 4242;
    });

    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({ configRef: DIGEST, forkFn, ledger, tag: 'parent-xyz' }),
    );

    expect(r).toBe(0);
    expect(createdSessions).toEqual([{ configRef: DIGEST }]);
    expect(forkFn).toHaveBeenCalledTimes(1);
    const [sid, tok, env] = forkFn.mock.calls[0]!;
    expect(sid).toBe('sess-abc');
    expect(tok).toBe('tok-xyz');
    expect(env).toMatchObject({
      sessionId: 'sess-abc',
      kind: 'prompt',
      prompt: 'summarize the repo',
      // Envelope carries configRef so `/v1/runs` resolves the bundle for this leaf (M1).
      configRef: DIGEST,
    });
    // Final ledger state has the pid filled in.
    const final = openLedger(ledgerPath).readAll();
    expect(final[0]!.childPid).toBe(4242);
    expect(final[0]!.tag).toBe('parent-xyz');
    expect(final[0]!.bundle).toBe(DIGEST);
    // Non-JSON output includes the sessionId on stdout (so a shell can capture it).
    expect(out.join('')).toContain('sess-abc');
    // The 'spawned' message goes to stderr (so --json piping stays clean).
    expect(err.join('\n')).toMatch(/spawned sess-abc.*pid 4242/);
  });

  it('omits configRef from the envelope when --config is not given (unbundled run)', async () => {
    const { rt } = makeRt();
    const { io } = makeIo();
    let seenEnvelope: LeafEnvelope | undefined;
    const forkFn: SpawnOptions['forkFn'] = (_sid, _tok, env) => {
      seenEnvelope = env;
      return 1;
    };
    const r = await cmdSpawn(rt, io, baseOpts({ forkFn, ledger: withLedger(rt) }));
    expect(r).toBe(0);
    expect(seenEnvelope?.configRef).toBeUndefined();
  });

  it('solve envelope carries problemStatement, not prompt', async () => {
    const { rt } = makeRt();
    const { io } = makeIo();
    let seenEnvelope: LeafEnvelope | undefined;
    const forkFn: SpawnOptions['forkFn'] = (_sid, _tok, env) => {
      seenEnvelope = env;
      return 1;
    };
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({
        prompt: 'Fix the lint warning on main.ts',
        kind: 'solve',
        repoUrl: 'https://x',
        ref: 'main',
        forkFn,
        ledger: withLedger(rt),
      }),
    );
    expect(r).toBe(0);
    expect(seenEnvelope?.kind).toBe('solve');
    expect(seenEnvelope?.problemStatement).toBe('Fix the lint warning on main.ts');
    expect(seenEnvelope?.prompt).toBeUndefined();
  });

  it('emits a JSON line to stdout with --json; the human message stays on stderr', async () => {
    const { rt } = makeRt();
    const { io, out, err } = makeIo();
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({ configRef: DIGEST, json: true, forkFn: () => 1234, ledger: withLedger(rt) }),
    );
    expect(r).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ type: 'session', sessionId: 'sess-abc', pid: 1234 });
    // Human-readable 'spawned' line never pollutes --json stdout.
    for (const line of out) expect(line).not.toMatch(/^spawned/);
  });

  it('builds a solve envelope that carries both repoUrl and ref through to the fork', async () => {
    const { rt } = makeRt();
    const { io } = makeIo();
    let seenEnvelope: LeafEnvelope | undefined;
    const forkFn: SpawnOptions['forkFn'] = (_sid, _tok, env) => {
      seenEnvelope = env;
      return 1;
    };
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({
        kind: 'solve',
        repoUrl: 'https://example.test/repo.git',
        ref: 'main',
        forkFn,
        ledger: withLedger(rt),
      }),
    );
    expect(r).toBe(0);
    expect(seenEnvelope?.kind).toBe('solve');
    expect(seenEnvelope?.repoUrl).toBe('https://example.test/repo.git');
    expect(seenEnvelope?.ref).toBe('main');
  });
});

/* --- failure paths --- */

describe('cmdSpawn — oversized prompt is refused up front', () => {
  it('refuses a prompt over the 64 KiB cap', async () => {
    const { rt, cp } = makeRt();
    const { io, err } = makeIo();
    const big = 'x'.repeat(64 * 1024 + 1);
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({ prompt: big, forkFn: () => 1, ledger: withLedger(rt) }),
    );
    expect(r).toBe(2);
    expect(cp.createSession).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('too large');
  });
});

describe('cmdSpawn — failure paths that must not create a ledger orphan', () => {
  it('fork throwing after createSession marks the ledger row failed', async () => {
    const { rt } = makeRt();
    const ledger = withLedger(rt);
    const { io, err } = makeIo();
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({
        configRef: DIGEST,
        forkFn: () => {
          throw new Error('log open failed: ENOSPC');
        },
        ledger,
      }),
    );
    expect(r).toBe(1);
    expect(err.join('\n')).toContain('ENOSPC');
    const only = openLedger(ledgerPath).readAll()[0]!;
    expect(only.lastKnownState).toBe('failed');
    expect(only.stateDetail).toContain('ENOSPC');
  });

  it('createSession throwing leaves the ledger empty', async () => {
    const { rt, cp } = makeRt();
    cp.createSession.mockRejectedValueOnce(new Error('control plane unreachable'));
    const ledger = withLedger(rt);
    const { io, err } = makeIo();
    const forkFn = vi.fn(() => 1);
    const r = await cmdSpawn(rt, io, baseOpts({ forkFn, ledger }));
    expect(r).toBe(1);
    expect(err.join('\n')).toContain('control plane unreachable');
    expect(forkFn).not.toHaveBeenCalled();
    expect(openLedger(ledgerPath).readAll()).toEqual([]);
  });

  it('async fork rejection (ENOENT after spawn returns) marks the ledger failed', async () => {
    // Simulates the adversary-M3 case: child_process.spawn emits an 'error' event asynchronously
    // (next tick) rather than throwing. The fork seam here delivers the rejection as a Promise,
    // which is the shape defaultFork now awaits in the real binary.
    const { rt } = makeRt();
    const ledger = withLedger(rt);
    const { io, err } = makeIo();
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({
        configRef: DIGEST,
        forkFn: async () => {
          await Promise.resolve();
          throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
        },
        ledger,
      }),
    );
    expect(r).toBe(1);
    expect(err.join('\n')).toContain('ENOENT');
    const only = openLedger(ledgerPath).readAll()[0]!;
    expect(only.lastKnownState).toBe('failed');
    expect(only.stateDetail).toContain('ENOENT');
  });
});

// Imported late to keep the file's top imports stable.
type LedgerRecord = ReturnType<Ledger['readAll']>[number];

/* --- --workload --- */

describe('cmdSpawn — --workload', () => {
  it('sends workloadId in the run envelope and records it in the ledger row', async () => {
    const { rt } = makeRt();
    const ledger = withLedger(rt);
    const { io } = makeIo();
    let seenEnvelope: LeafEnvelope | undefined;
    const forkFn: SpawnOptions['forkFn'] = (_sid, _tok, env) => {
      seenEnvelope = env;
      return 7;
    };
    const r = await cmdSpawn(rt, io, baseOpts({ workloadId: 'demo', forkFn, ledger }));
    expect(r).toBe(0);
    expect(seenEnvelope).toEqual({
      sessionId: 'sess-abc',
      kind: 'prompt',
      prompt: 'summarize the repo',
      workloadId: 'demo',
    });
    const row = openLedger(ledgerPath).readAll()[0]!;
    expect(row.workloadId).toBe('demo');
    expect(row.envelope.workloadId).toBe('demo');
  });

  it('refuses --workload with --kind solve, and an invalid workload id, before creating a session', async () => {
    for (const over of [
      { kind: 'solve' as const, repoUrl: 'https://x', ref: 'main', workloadId: 'demo' },
      { workloadId: 'Bad/Id' },
    ]) {
      const { rt, cp } = makeRt();
      const { io, err } = makeIo();
      const r = await cmdSpawn(
        rt,
        io,
        baseOpts({ ...over, forkFn: () => 1, ledger: withLedger(rt) }),
      );
      expect(r).toBe(2);
      expect(cp.createSession).not.toHaveBeenCalled();
      expect(err.join('\n')).toMatch(/--workload needs --kind prompt|invalid workload id/);
    }
  });

  it('--writable sends contextWritable and records writable in the ledger row', async () => {
    const { rt } = makeRt();
    const ledger = withLedger(rt);
    const { io } = makeIo();
    let seenEnvelope: LeafEnvelope | undefined;
    const forkFn: SpawnOptions['forkFn'] = (_sid, _tok, env) => {
      seenEnvelope = env;
      return 7;
    };
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({ workloadId: 'demo', writable: true, forkFn, ledger }),
    );
    expect(r).toBe(0);
    expect(seenEnvelope).toEqual({
      sessionId: 'sess-abc',
      kind: 'prompt',
      prompt: 'summarize the repo',
      workloadId: 'demo',
      contextWritable: true,
    });
    const row = openLedger(ledgerPath).readAll()[0]!;
    expect(row.writable).toBe(true);
    expect(row.envelope.contextWritable).toBe(true);
  });

  it('a read-only workload run sends no contextWritable and records no writable', async () => {
    const { rt } = makeRt();
    const ledger = withLedger(rt);
    let seenEnvelope: LeafEnvelope | undefined;
    const forkFn: SpawnOptions['forkFn'] = (_sid, _tok, env) => {
      seenEnvelope = env;
      return 7;
    };
    await cmdSpawn(
      rt,
      makeIo().io,
      baseOpts({ workloadId: 'demo', writable: false, forkFn, ledger }),
    );
    expect(seenEnvelope).not.toHaveProperty('contextWritable');
    expect(openLedger(ledgerPath).readAll()[0]).not.toHaveProperty('writable');
  });

  it('refuses --writable without --workload before creating a session', async () => {
    const { rt, cp } = makeRt();
    const { io, err } = makeIo();
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({ writable: true, forkFn: () => 1, ledger: withLedger(rt) }),
    );
    expect(r).toBe(2);
    expect(cp.createSession).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('--writable needs --workload ID');
  });

  it('preflights the workload with GET /workloads/{id} and the API token', async () => {
    const { rt, cp } = makeRt();
    const calls: Array<{ url: string; method?: string; auth?: string }> = [];
    rt.fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method,
        auth: (init.headers as Record<string, string>).authorization,
      });
      return new Response(JSON.stringify({ workloadId: 'demo', status: 'ready' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const r = await cmdSpawn(
      rt,
      makeIo().io,
      baseOpts({
        workloadId: 'demo',
        workloads: undefined,
        forkFn: () => 7,
        ledger: withLedger(rt),
      }),
    );
    expect(r).toBe(0);
    expect(calls).toEqual([
      { url: 'https://harness.test/workloads/demo', method: 'GET', auth: 'Bearer api-tok' },
    ]);
    expect(cp.createSession).toHaveBeenCalled();
  });

  it.each(['awaiting_upload', 'creating', 'deleting'])(
    'exits 1 for a %s workload before creating a session or forking',
    async (status) => {
      const { rt, cp } = makeRt();
      const { io, err } = makeIo();
      const forkFn = vi.fn(() => 7);
      const r = await cmdSpawn(
        rt,
        io,
        baseOpts({
          workloadId: 'demo',
          workloads: workloadsReturning(status),
          forkFn,
          ledger: withLedger(rt),
        }),
      );
      expect(r).toBe(1);
      expect(cp.createSession).not.toHaveBeenCalled();
      expect(forkFn).not.toHaveBeenCalled();
      expect(err.join('\n')).toContain(`workload demo is ${status}, not ready`);
    },
  );

  it('exits 1 for a missing workload, or one that is not yours', async () => {
    const { rt, cp } = makeRt();
    const { io, err } = makeIo();
    const workloads = {
      get: vi.fn(async () => {
        throw new ApiError('harness', 404, 'workload_not_found');
      }),
    };
    const r = await cmdSpawn(
      rt,
      io,
      baseOpts({ workloadId: 'demo', workloads, forkFn: () => 7, ledger: withLedger(rt) }),
    );
    expect(r).toBe(1);
    expect(cp.createSession).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain("no workload 'demo' (or it is not yours)");
    expect(openLedger(ledgerPath).readAll()).toEqual([]);
  });

  it('the worker transport puts workloadId in the POST /v1/runs body', async () => {
    const { LeafTransport } = await import('../src/transport/leaf-turn.js');
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ status: 'responded', text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const transport = new LeafTransport({ baseUrl: async () => 'https://harness.test' }, fetchImpl);
    await transport.submitLeafTurn(
      { sessionId: 's', kind: 'prompt', prompt: 'p', workloadId: 'demo' },
      'tok',
    );
    expect(bodies[0]).toMatchObject({ kind: 'prompt', workloadId: 'demo' });
  });
});
