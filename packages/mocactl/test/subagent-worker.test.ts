import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSpawnWorker, type SpawnWorkerPayload } from '../src/subagent.js';
import { openLedger } from '../src/core/subagent-ledger.js';
import {
  LeafTransport,
  type LeafEnvelope,
  type LeafResultBody,
} from '../src/transport/leaf-turn.js';

/** Pins every runSpawnWorker exit path to a ledger state `subagents` can read. */

const ENV: LeafEnvelope = {
  sessionId: 'sess-abc',
  kind: 'prompt',
  prompt: 'hi',
  configRef: 'sha256:' + 'a'.repeat(64),
};

function makeRt(scratch: string, over: Partial<any> = {}): any {
  // Fake clock: `sleep` advances `now` so the retry wall budget moves without real waits.
  let t = 10_000;
  return {
    cp: {},
    harness: { baseUrl: async () => 'https://harness.test' },
    auth: { subject: 'alice', apiToken: 'x', expiresAt: 999 },
    paths: { stateDir: scratch, subagentsFile: join(scratch, 'subagents.jsonl') },
    endpoints: { controlPlaneUrl: undefined, harnessUrl: undefined },
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    fetchImpl: fetch,
    config: {},
    ...over,
  };
}

function payloadStdin(payload: Partial<SpawnWorkerPayload>): () => Promise<string> {
  return async () => JSON.stringify(payload);
}

function seedLedgerRow(ledgerPath: string, sessionId = 'sess-abc') {
  const ledger = openLedger(ledgerPath);
  ledger.append({
    sessionId,
    envelope: { kind: 'prompt', prompt: 'hi' },
    submittedAt: 1,
    lastKnownState: 'running',
    stateObservedAt: 1,
  });
}

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'worker-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/* --- happy path --- */

describe('runSpawnWorker — happy path', () => {
  it('on a terminal responded body, marks the ledger done and exits 0', async () => {
    const rt = makeRt(scratch);
    const ledgerPath = rt.paths.subagentsFile;
    seedLedgerRow(ledgerPath);
    const transport = {
      submitLeafTurn: vi.fn(
        async () => ({ status: 'responded', text: 'hi back' }) as LeafResultBody,
      ),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(0);
    const row = openLedger(ledgerPath).readAll()[0]!;
    expect(row.lastKnownState).toBe('done');
    // Envelope carries configRef so `/v1/runs` resolves the bundle.
    expect(transport.submitLeafTurn).toHaveBeenCalledWith(
      expect.objectContaining({ configRef: ENV.configRef }),
      'tok',
    );
  });
});

/* --- failure paths: after-send reconciles, connect-phase stays terminal, server rejection stays terminal --- */

describe('runSpawnWorker — after-send fetch error reconciles instead of recording terminal failed', () => {
  it('UND_ERR_HEADERS_TIMEOUT (undici 5-min cutoff after request landed) → non-terminal + reconcile hint', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const transport = {
      submitLeafTurn: vi.fn(async () => {
        throw new ApiError(
          'harness',
          0,
          'network_error',
          'fetch failed',
          undefined,
          'UND_ERR_HEADERS_TIMEOUT',
        );
      }),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(1);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('running');
    expect(row.stateDetail).toContain('client disconnected');
    expect(row.stateDetail).toContain('reconciling');
  });

  it('UND_ERR_BODY_TIMEOUT also reconciles', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const transport = {
      submitLeafTurn: vi.fn(async () => {
        throw new ApiError(
          'harness',
          0,
          'network_error',
          'terminated',
          undefined,
          'UND_ERR_BODY_TIMEOUT',
        );
      }),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(1);
    expect(openLedger(rt.paths.subagentsFile).readAll()[0]!.lastKnownState).toBe('running');
  });

  it('UND_ERR_SOCKET is ambiguous (fires both before and after send on the same code) and stays terminal', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const transport = {
      submitLeafTurn: vi.fn(async () => {
        throw new ApiError(
          'harness',
          0,
          'network_error',
          'other side closed',
          undefined,
          'UND_ERR_SOCKET',
        );
      }),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(1);
    // Verified by a Node 24 probe: UND_ERR_SOCKET also fires when the server destroys the
    // socket before reading any bytes, so we cannot safely treat it as "server has the record".
    expect(openLedger(rt.paths.subagentsFile).readAll()[0]!.lastKnownState).toBe('failed');
  });
});

describe('runSpawnWorker — connect-phase and server rejection stay terminal', () => {
  it('ECONNREFUSED (server never saw request) → terminal failed, not reconciling', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const transport = {
      submitLeafTurn: vi.fn(async () => {
        throw new ApiError(
          'harness',
          0,
          'network_error',
          'connect ECONNREFUSED',
          undefined,
          'ECONNREFUSED',
        );
      }),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(1);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('failed');
    expect(row.stateDetail).toContain('ECONNREFUSED');
    expect(row.stateDetail).not.toContain('reconciling');
  });

  it('ENOTFOUND (DNS) and UND_ERR_CONNECT_TIMEOUT also stay terminal', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    for (const code of ['ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN']) {
      const rt = makeRt(scratch);
      seedLedgerRow(rt.paths.subagentsFile);
      const transport = {
        submitLeafTurn: vi.fn(async () => {
          throw new ApiError('harness', 0, 'network_error', code, undefined, code);
        }),
      } as unknown as LeafTransport;
      await runSpawnWorker(rt, {
        readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
        transport,
      });
      expect(openLedger(rt.paths.subagentsFile).readAll()[0]!.lastKnownState).toBe('failed');
    }
  });

  it('a plain Error (no cause code) stays terminal — we only reconcile when we know it is after-send', async () => {
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const transport = {
      submitLeafTurn: vi.fn(async () => {
        throw new Error('mystery');
      }),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(1);
    expect(openLedger(rt.paths.subagentsFile).readAll()[0]!.lastKnownState).toBe('failed');
  });

  it('server rejection (ApiError with HTTP status) remains terminal', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const transport = {
      submitLeafTurn: vi.fn(async () => {
        throw new ApiError('harness', 400, 'bad_inputs', 'empty prompt');
      }),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(1);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('failed');
    expect(row.stateDetail).toContain('empty prompt');
  });
});

describe('runSpawnWorker — terminal failed paths that remain terminal', () => {
  it('on a terminal failed body, mirrors the server reason into the ledger detail', async () => {
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const transport = {
      submitLeafTurn: vi.fn(
        async () =>
          ({ status: 'failed', reason: 'bad_inputs', message: 'empty prompt' }) as LeafResultBody,
      ),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(1);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('failed');
    expect(row.stateDetail).toBe('bad_inputs');
  });

  it('with no harness URL and no forwarded endpoints, writes a failed ledger line', async () => {
    const rt = makeRt(scratch, { harness: undefined });
    seedLedgerRow(rt.paths.subagentsFile);
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
    });
    expect(r).toBe(2);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('failed');
    expect(row.stateDetail).toContain('harness URL');
  });
});

/* --- retryable path: saturation retries then records a terminal row --- */

describe('runSpawnWorker — sync 503 saturated retries with bounded budget', () => {
  it('retries up to 3 times honoring Retry-After, then records failed with the saturated detail', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const transport = {
      submitLeafTurn: vi.fn(async () => {
        throw new ApiError('harness', 503, 'saturated', 'pool full', 1);
      }),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(1);
    // Initial + 2 retries = 3 attempts.
    expect((transport.submitLeafTurn as any).mock.calls.length).toBe(3);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('failed');
    expect(row.stateDetail).toBe('saturated — exhausted retries');
  });

  it('succeeds on a retry if the pool frees up (no terminal failed row recorded)', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    let calls = 0;
    const transport = {
      submitLeafTurn: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new ApiError('harness', 503, 'saturated', 'pool full', 0);
        return { status: 'responded', text: 'ok' } as LeafResultBody;
      }),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(0);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('done');
  });

  // Fetch cut off client-side → worker records non-terminal; next `cmdSubagents` poll reads
  // `/runs/status` and flips the ledger to the real server-side outcome.
  it('end-to-end: fetch error on POST /v1/runs lets cmdSubagents reconcile to done via GET /runs/status', async () => {
    const { cmdSubagents } = await import('../src/subagent.js');
    const rt = makeRt(scratch, {
      // mintSessionToken used by cmdSubagents to re-poll /runs/status
      cp: { mintSessionToken: vi.fn(async () => ({ token: 'tok', expiresAt: 9 })) },
    });
    seedLedgerRow(rt.paths.subagentsFile);

    // Phase 1: worker fetch throws with the undici headers-timeout cause code — the real
    // #515 shape. Ledger must stay non-terminal so cmdSubagents re-polls.
    const { ApiError } = await import('../src/api/errors.js');
    const workerTransport = {
      submitLeafTurn: vi.fn(async () => {
        throw new ApiError(
          'harness',
          0,
          'network_error',
          'fetch failed',
          undefined,
          'UND_ERR_HEADERS_TIMEOUT',
        );
      }),
    } as unknown as LeafTransport;
    const workerRc = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport: workerTransport,
    });
    expect(workerRc).toBe(1);
    const after1 = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(after1.lastKnownState).toBe('running');
    expect(after1.stateDetail).toContain('reconciling');

    // Phase 2: cmdSubagents re-polls /runs/status; the server has recorded a terminal success.
    const io = { out: vi.fn(), err: vi.fn() };
    const subagentsTransport = {
      readLeafState: vi.fn(async () => ({ status: 'responded', text: 'done' })),
    } as unknown as LeafTransport;
    const subRc = await cmdSubagents(rt, io, {
      json: true,
      transport: subagentsTransport,
    });
    expect(subRc).toBe(0);
    // Ledger reconciled to done — the user no longer sees a misleading "failed".
    const after2 = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(after2.lastKnownState).toBe('done');
  });

  // Guards against the "retry loop never fires in production" mode by driving through the real
  // LeafTransport + errorFromResponse; fails if `body.reason` ever stops folding into `code`.
  it('end-to-end: a real 503 response body drives the retry loop', async () => {
    let hits = 0;
    const fakeFetch = vi.fn(async (url: string | URL) => {
      hits += 1;
      if (hits <= 1) {
        return new Response(JSON.stringify({ status: 'failed', reason: 'saturated' }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        });
      }
      return new Response(JSON.stringify({ status: 'responded', text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const rt = makeRt(scratch, { fetchImpl: fakeFetch as unknown as typeof fetch });
    seedLedgerRow(rt.paths.subagentsFile);
    const { LeafTransport: LT } = await import('../src/transport/leaf-turn.js');
    const transport = new LT(rt.harness, rt.fetchImpl);
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(0);
    expect(hits).toBe(2);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('done');
  });
});

/* --- stdin-parse failures --- */

describe('runSpawnWorker — malformed stdin', () => {
  it('on non-JSON stdin, exits 2 without a ledger write', async () => {
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const r = await runSpawnWorker(rt, { readStdin: async () => 'not json' });
    expect(r).toBe(2);
    // Parent's row stays `running`; worker did not advance it.
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('running');
  });

  it('on JSON missing sessionId/token, exits 2 without crashing', async () => {
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const r = await runSpawnWorker(rt, {
      readStdin: async () => JSON.stringify({ envelope: ENV }),
    });
    expect(r).toBe(2);
  });
});

/* --- forwarded endpoints: parent passes URLs on stdin, child rebuilds its runtime --- */

describe('runSpawnWorker — endpoint forwarding', () => {
  it('rebuilds the harness client from stdin when the child has no endpoint flags', async () => {
    // Child has empty rt.harness/rt.endpoints; proves the applyEndpoints → wire → HarnessClient
    // chain runs by letting a fake fetch observe the final POST URL.
    const fetchCalls: string[] = [];
    const fakeFetch = vi.fn(async (url: string | URL) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify({ status: 'responded', text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const rt = makeRt(scratch, {
      harness: undefined,
      endpoints: { controlPlaneUrl: undefined, harnessUrl: undefined },
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    seedLedgerRow(rt.paths.subagentsFile);
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({
        sessionId: 'sess-abc',
        token: 'tok',
        envelope: ENV,
        harnessUrl: 'https://harness.test',
      }),
    });
    expect(r).toBe(0);
    expect(fetchCalls[0]).toBe('https://harness.test/v1/runs');
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('done');
  });

  it("overrides a child-side DiscoveringHarness so the parent's resolved URL wins", async () => {
    // Pins the "forwarded URL must apply even when rt.harness is already truthy" branch.
    const fetchCalls: string[] = [];
    const fakeFetch = vi.fn(async (url: string | URL) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify({ status: 'responded', text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const rt = makeRt(scratch, {
      // Simulates what the child's own buildRuntime would have wired up.
      harness: { baseUrl: async () => 'https://stale.test' },
      endpoints: { controlPlaneUrl: 'https://cp.test', harnessUrl: undefined },
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    seedLedgerRow(rt.paths.subagentsFile);
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({
        sessionId: 'sess-abc',
        token: 'tok',
        envelope: ENV,
        harnessUrl: 'https://harness.correct',
      }),
    });
    expect(r).toBe(0);
    expect(fetchCalls[0]).toBe('https://harness.correct/v1/runs');
  });
});
