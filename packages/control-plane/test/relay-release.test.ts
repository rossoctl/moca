import { describe, expect, it, vi, afterEach } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { CONTROL_PLANE_SECRETS } from '../src/main.js';
import {
  httpRelayReleaser,
  releaseUrl,
  releaserOf,
  relayReleaseFromEnv,
  withinBound,
  type ReleaseAnswer,
  type RelayReleaser,
} from '../src/relay-release.js';
import { alice, ctx, makeDeps, NOW_MS, seedCredential, type TestDeps } from './helpers/deps.js';

// #338: the control plane releases an ended sandbox's (or session's) workspace on its worker
// through the relay's control listener. `releasedAt` only on a terminal answer (released,
// kept_busy, unknown_key, unsupported), so the janitor's next sweep retries anything else while the
// record is retained; a delete releases only after its record (or session) delete committed; and
// a release never fails or holds up the DELETE or the sweep past the bound.

const NOW = Math.floor(NOW_MS / 1000);
const DAY_MS = 86_400_000;
const TOKEN = 't'.repeat(64); // notsecret

afterEach(() => vi.restoreAllMocks());

interface Call {
  worker: string;
  workspaceKey: string;
}

/** A releaser answering `answer(call)`: a terminal answer, a thrown error, or never (`'hang'`). */
function fakeReleaser(answer: (c: Call) => ReleaseAnswer | Error | 'hang' = () => 'released') {
  const calls: Call[] = [];
  const releaser: RelayReleaser = {
    release: (worker, workspaceKey, signal) => {
      calls.push({ worker, workspaceKey });
      const a = answer({ worker, workspaceKey });
      if (a === 'hang') {
        // Honors the abort, as fetch does; the bound must not depend on it either (see below).
        return new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      }
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    },
  };
  return { releaser, calls };
}

let seq = 0;
const sbxDeps = (over: Parameters<typeof makeDeps>[0] = {}): TestDeps =>
  makeDeps({
    newId: () => (++seq).toString(16).padStart(26, '0'),
    ...over,
    config: { routeProfile: 'sandbox', ...(over.config ?? {}) },
  });
const create = async (d: TestDeps, at = NOW_MS) =>
  (
    await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 'default' } }), {
      ...d,
      now: () => at,
    })
  ).body as { id: string };
const on = (id: string) => ctx({ principal: alice, params: { id } });
const sweep = (d: TestDeps) => HANDLERS.janitorSandboxes!(ctx({ janitorAuthorized: true }), d);
const record = (d: TestDeps, id: string) => d.sandboxes!.get(id, NOW);
const decisions = (d: TestDeps, decision: string) =>
  [...d.streams.values()].flat().filter((r) => r.decision === decision);
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('relayReleaseFromEnv (#338)', () => {
  it('is off without SH_RELAY_CONTROL_URL, whatever else is set', () => {
    expect(relayReleaseFromEnv({})).toBeUndefined();
    expect(relayReleaseFromEnv({ MOCA_RELAY_RELEASE_TOKEN: TOKEN })).toBeUndefined();
    expect(relayReleaseFromEnv({ SH_RELAY_CONTROL_URL: ' ' })).toBeUndefined();
  });

  it('refuses a URL without the bearer, a short bearer, a bad URL, and a bearer it shares', () => {
    const url = 'http://sandbox-relay-control:9445';
    expect(() => relayReleaseFromEnv({ SH_RELAY_CONTROL_URL: url })).toThrow(
      /needs MOCA_RELAY_RELEASE_TOKEN/,
    );
    expect(() =>
      relayReleaseFromEnv({ SH_RELAY_CONTROL_URL: url, MOCA_RELAY_RELEASE_TOKEN: 'short' }),
    ).toThrow(/at least 32 characters/);
    expect(() =>
      relayReleaseFromEnv({ SH_RELAY_CONTROL_URL: 'relay:9445', MOCA_RELAY_RELEASE_TOKEN: TOKEN }),
    ).toThrow(/absolute http\(s\) URL/);
    let msg = '';
    try {
      relayReleaseFromEnv({ SH_RELAY_CONTROL_URL: url, MOCA_RELAY_RELEASE_TOKEN: TOKEN }, [TOKEN]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/must differ from every other control-plane secret/);
    expect(msg).not.toContain(TOKEN);
    expect(
      relayReleaseFromEnv({ SH_RELAY_CONTROL_URL: url, MOCA_RELAY_RELEASE_TOKEN: TOKEN }, ['x']),
    ).toBeDefined();
  });

  it('reads the bearer as a credential file, like every control-plane secret', () => {
    expect(CONTROL_PLANE_SECRETS).toContain('MOCA_RELAY_RELEASE_TOKEN');
  });
});

describe('httpRelayReleaser (#338)', () => {
  const answering = (status: number, body: unknown) => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { f, seen };
  };

  it.each([
    ['released', 'released'],
    ['kept_busy', 'kept_busy'],
    ['unknown_key', 'unknown_key'],
    ['release_unsupported', 'unsupported'],
  ])('maps 200 {outcome: %s} to the terminal answer %s', async (outcome, want) => {
    const { f, seen } = answering(200, { outcome });
    const r = httpRelayReleaser({ url: 'http://relay:9445/', token: TOKEN }, f);
    expect(await r.release('sbx_default', 'sbx-1', new AbortController().signal)).toBe(want);
    expect(seen[0]!.url).toBe('http://relay:9445/v1/release');
    expect(seen[0]!.init.method).toBe('POST');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({
      worker: 'sbx_default',
      workspaceKey: 'sbx-1',
    });
  });

  it.each([
    [503, { error: 'unavailable' }],
    [504, { error: 'timeout' }],
    [401, { error: 'unauthorized' }],
    [200, { outcome: 'something_new' }],
    [200, 'not an object'],
  ])('rejects anything else (%i %j): not an answer', async (status, body) => {
    const { f } = answering(status, body);
    await expect(
      httpRelayReleaser({ url: 'http://relay:9445', token: TOKEN }, f).release(
        'w',
        'k',
        new AbortController().signal,
      ),
    ).rejects.toThrow(/the relay answered/);
  });
});

describe('releaseUrl and releaserOf (#338)', () => {
  it('trims any number of trailing slashes, and only those, without a backtracking regex', () => {
    expect(releaseUrl('http://relay:9445')).toBe('http://relay:9445/v1/release');
    expect(releaseUrl('http://relay:9445/')).toBe('http://relay:9445/v1/release');
    expect(releaseUrl('http://relay:9445///')).toBe('http://relay:9445/v1/release');
    expect(releaseUrl('http://relay:9445/base//')).toBe('http://relay:9445/base/v1/release');
    // Many slashes stay linear: a regex like /\/+$/ can backtrack on these.
    const many = `http://relay:9445${'/'.repeat(100_000)}x`;
    const t0 = Date.now();
    expect(releaseUrl(many)).toBe(`${many}/v1/release`);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("uses an injected releaser, else the config's listener, else none", async () => {
    const injected = fakeReleaser().releaser;
    expect(releaserOf({ relayRelease: injected, config: {} })).toBe(injected);
    expect(releaserOf({ config: {} })).toBeUndefined();
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ outcome: 'released' }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = releaserOf({
      fetchImpl: f,
      config: { relayRelease: { url: 'http://relay:9445/', token: TOKEN } },
    });
    expect(await r!.release('w', 'k', new AbortController().signal)).toBe('released');
    expect(seen).toEqual(['http://relay:9445/v1/release']);
  });
});

describe('withinBound (#338)', () => {
  it('returns at the bound whatever the work does, aborting its signal', async () => {
    let aborted = false;
    const t0 = Date.now();
    await withinBound(50, async (signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      // Ignores the abort entirely: the bound still holds.
      await new Promise(() => {});
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(aborted).toBe(true);
  });

  it('never rejects', async () => {
    await expect(
      withinBound(1000, async () => {
        throw new Error('boom');
      }),
    ).resolves.toBeUndefined();
  });
});

describe('a sandbox delete releases its workspace (#338)', () => {
  it('sends the worker and workspace key only after markDeleted, and records releasedAt', async () => {
    const d = sbxDeps();
    const { id } = await create(d);
    const states: Array<string | undefined> = [];
    const { releaser, calls } = fakeReleaser();
    d.relayRelease = {
      release: async (w, k, s) => {
        // The record is already deleted when the release goes out.
        states.push((await record(d, id))?.deletedAt === undefined ? 'live' : 'deleted');
        return releaser.release(w, k, s);
      },
    };
    const res = await HANDLERS.deleteSandbox!(on(id), d);
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect((await record(d, id))?.releasedAt).toBe(NOW));
    expect(calls).toEqual([{ worker: 'sbx_default', workspaceKey: id }]);
    expect(states).toEqual(['deleted']);
    await vi.waitFor(() =>
      expect(decisions(d, 'sandbox_workspace_release')).toEqual([
        expect.objectContaining({ subject: 'github:1234', sandboxId: id, outcome: 'released' }),
      ]),
    );
  });

  it.each(['released', 'kept_busy', 'unknown_key', 'unsupported'] as const)(
    'records releasedAt on the terminal answer %s',
    async (answer) => {
      const d = sbxDeps();
      const { id } = await create(d);
      d.relayRelease = fakeReleaser(() => answer).releaser;
      await HANDLERS.deleteSandbox!(on(id), d);
      await vi.waitFor(async () => expect((await record(d, id))?.releasedAt).toBe(NOW));
      await vi.waitFor(() =>
        expect(decisions(d, 'sandbox_workspace_release')[0]).toMatchObject({ outcome: answer }),
      );
    },
  );

  it('leaves releasedAt unset on a transport failure, and the next sweep retries', async () => {
    quiet();
    const d = sbxDeps();
    const { id } = await create(d);
    let fail = true;
    const { releaser, calls } = fakeReleaser(() =>
      fail ? new Error('the relay answered 503 unavailable') : 'released',
    );
    d.relayRelease = releaser;
    expect((await HANDLERS.deleteSandbox!(on(id), d)).status).toBe(200);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await tick();
    expect((await record(d, id))?.releasedAt).toBeUndefined();
    expect(decisions(d, 'sandbox_workspace_release')).toEqual([]);
    // The sweep sends it again (the failed attempt dropped its claim): still failing, still unset.
    await sweep(d);
    expect(calls).toHaveLength(2);
    expect((await record(d, id))?.releasedAt).toBeUndefined();
    fail = false;
    await sweep(d);
    expect((await record(d, id))?.releasedAt).toBe(NOW);
    // Answered: never sent again.
    await sweep(d);
    expect(calls).toHaveLength(3);
  });

  it('returns before a release that never answers settles, not at the bound', async () => {
    quiet();
    const d = sbxDeps(); // the default 5 s bound
    const { id } = await create(d);
    // Never settles and ignores the abort.
    d.relayRelease = { release: () => new Promise(() => {}) };
    const t0 = Date.now();
    const res = await HANDLERS.deleteSandbox!(on(id), d);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(res.body).toMatchObject({ id, state: 'terminated', reason: 'deleted' });
    expect((await record(d, id))?.releasedAt).toBeUndefined();
  });

  it('a release that rejects or throws synchronously is no unhandled rejection, and the DELETE stands', async () => {
    quiet();
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const d = sbxDeps();
      const a = await create(d);
      d.relayRelease = { release: () => Promise.reject(new Error('connect ECONNREFUSED')) };
      expect((await HANDLERS.deleteSandbox!(on(a.id), d)).body).toMatchObject({
        reason: 'deleted',
      });
      const b = await create(d);
      d.relayRelease = {
        release: () => {
          throw new Error('thrown before any promise');
        },
      };
      expect((await HANDLERS.deleteSandbox!(on(b.id), d)).body).toMatchObject({
        reason: 'deleted',
      });
      const c = await create(d);
      d.relayRelease = fakeReleaser().releaser;
      d.sandboxes!.markReleased = async () => {
        throw new Error('redis down');
      };
      expect((await HANDLERS.deleteSandbox!(on(c.id), d)).body).toMatchObject({
        reason: 'deleted',
      });
      const e = await create(d);
      d.sandboxes!.claimRelease = async () => {
        throw new Error('redis down');
      };
      expect((await HANDLERS.deleteSandbox!(on(e.id), d)).body).toMatchObject({
        reason: 'deleted',
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
      for (const x of [a, b]) expect((await record(d, x.id))?.releasedAt).toBeUndefined();
      // A failed releasedAt write is not audited: the release will be sent, and audited, again.
      expect(decisions(d, 'sandbox_workspace_release')).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('sends once: two DELETEs, or a DELETE and a sweep, race for one claim', async () => {
    const d = sbxDeps();
    const { id } = await create(d);
    let answer!: (a: ReleaseAnswer) => void;
    const calls: string[] = [];
    d.relayRelease = {
      release: (_w, k) => {
        calls.push(k);
        return new Promise<ReleaseAnswer>((r) => (answer = r));
      },
    };
    await HANDLERS.deleteSandbox!(on(id), d);
    await HANDLERS.deleteSandbox!(on(id), d);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const swept = sweep(d);
    await tick();
    expect(calls).toHaveLength(1);
    answer('released');
    await swept;
    await vi.waitFor(async () => expect((await record(d, id))?.releasedAt).toBe(NOW));
    await sweep(d);
    expect(calls).toHaveLength(1);
    await vi.waitFor(() => expect(decisions(d, 'sandbox_workspace_release')).toHaveLength(1));
  });

  it('sends nothing and records nothing without a releaser', async () => {
    const d = sbxDeps();
    const { id } = await create(d);
    await HANDLERS.deleteSandbox!(on(id), d);
    await sweep(d);
    expect(await record(d, id)).not.toHaveProperty('releasedAt');
    expect(decisions(d, 'sandbox_workspace_release')).toEqual([]);
  });
});

describe("the janitor's sweep releases expired sandboxes (#338)", () => {
  it('releases an expired sandbox regardless of provenance, once, and never a live one', async () => {
    const d = sbxDeps();
    expect(d.provenance).toBeUndefined();
    // Created a lifetime ago, so it expires exactly now: ended by the clock alone.
    const aged = await create(d, NOW_MS - 7 * DAY_MS);
    const live = await create(d);
    const { releaser, calls } = fakeReleaser();
    d.relayRelease = releaser;
    const res = await sweep(d);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ worker: 'sbx_default', workspaceKey: aged.id }]);
    expect((await record(d, aged.id))?.releasedAt).toBe(NOW);
    expect(await record(d, live.id)).not.toHaveProperty('releasedAt');
    expect(decisions(d, 'sandbox_workspace_release')).toEqual([
      expect.objectContaining({ subject: 'janitor', sandboxId: aged.id, outcome: 'released' }),
    ]);
    await sweep(d);
    expect(calls).toHaveLength(1);
  });

  it('answers the janitor within the bound when the relay never answers', async () => {
    quiet();
    const d = sbxDeps({ releaseBoundMs: 100 });
    const aged = await create(d, NOW_MS - 7 * DAY_MS);
    d.relayRelease = fakeReleaser(() => 'hang').releaser;
    const t0 = Date.now();
    const res = await sweep(d);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((res.body as { terminated: unknown[] }).terminated).toHaveLength(1);
    expect((await record(d, aged.id))?.releasedAt).toBeUndefined();
  });

  it('runs the releases a few at a time, and stops starting new ones at the bound', async () => {
    quiet();
    const d = sbxDeps({ releaseBoundMs: 150, config: { routeProfile: 'sandbox' } });
    d.config.sandbox!.maxTotal = 100;
    d.config.sandbox!.maxPerSubject = 100;
    for (let i = 0; i < 20; i++) await create(d, NOW_MS - 7 * DAY_MS);
    let open = 0;
    let most = 0;
    const calls: string[] = [];
    d.relayRelease = {
      release: async (_w, k) => {
        calls.push(k);
        open++;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 100));
        open--;
        return 'released';
      },
    };
    await sweep(d);
    expect(most).toBe(8);
    // At most two rounds of 8 start inside the 150 ms bound; the rest wait for the next sweep.
    expect(calls.length).toBeLessThanOrEqual(16);
    const released = async () =>
      (await d.sandboxes!.listAll(NOW)).filter((r) => r.releasedAt !== undefined).length;
    for (let i = 0; i < 5 && (await released()) < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      await sweep(d);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(await released()).toBe(20);
    // Each answered once: nothing answered is sent again.
    expect(new Set(calls).size).toBe(calls.length);
  });
});

describe('a session delete releases its workspace (#338)', () => {
  const sessionDeps = async (release?: RelayReleaser) => {
    const d = makeDeps(release ? { relayRelease: release } : {});
    await seedCredential(d);
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d);
    return d;
  };
  const del = (d: TestDeps) =>
    HANDLERS.deleteSession!(ctx({ principal: alice, params: { id: 'sid-fixed' } }), d);
  const lines = (d: TestDeps) => decisions(d, 'session_workspace_release');

  it("sends to the session's sandboxPod, keyed by the session id, only after the delete commits", async () => {
    const seen: Array<unknown> = [];
    const { releaser, calls } = fakeReleaser();
    const d = await sessionDeps({
      release: async (w, k, s) => {
        seen.push(await d.index.get('sid-fixed'));
        return releaser.release(w, k, s);
      },
    });
    await d.index.putRuntime('sid-fixed', { sandboxPod: 'moca-sandbox-0', sandboxId: 'other' });
    expect((await del(d)).status).toBe(204);
    await vi.waitFor(() => expect(lines(d)).toHaveLength(1));
    expect(calls).toEqual([{ worker: 'moca-sandbox-0', workspaceKey: 'sid-fixed' }]);
    // The session was already gone when the release went out.
    expect(seen).toEqual([null]);
    expect(lines(d)).toEqual([
      expect.objectContaining({
        sessionId: 'sid-fixed',
        worker: 'moca-sandbox-0',
        outcome: 'released',
      }),
    ]);
  });

  it('falls back to the sandboxId its last leased turn ran on', async () => {
    const { releaser, calls } = fakeReleaser(() => 'kept_busy');
    const d = await sessionDeps(releaser);
    await d.index.putRuntime('sid-fixed', { sandboxId: 'moca_microvm_0' });
    await del(d);
    await vi.waitFor(() => expect(lines(d)).toHaveLength(1));
    expect(calls).toEqual([{ worker: 'moca_microvm_0', workspaceKey: 'sid-fixed' }]);
    expect(lines(d)[0]).toMatchObject({ outcome: 'kept_busy', worker: 'moca_microvm_0' });
    // A worker id is not a sandbox record: the line names no sandboxId.
    expect(lines(d)[0]).not.toHaveProperty('sandboxId');
  });

  it('sends nothing with no worker recorded, and audits that', async () => {
    const { releaser, calls } = fakeReleaser();
    const d = await sessionDeps(releaser);
    expect((await del(d)).status).toBe(204);
    await vi.waitFor(() => expect(lines(d)).toHaveLength(1));
    expect(calls).toEqual([]);
    expect(lines(d)).toEqual([
      expect.objectContaining({ sessionId: 'sid-fixed', outcome: 'no_worker' }),
    ]);
    expect(lines(d)[0]).not.toHaveProperty('sandboxId');
    expect(lines(d)[0]).not.toHaveProperty('worker');
  });

  it('audits not_answered once and still deletes when the relay rejects or throws, with no unhandled rejection', async () => {
    quiet();
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const release of [
        () => Promise.reject(new Error('the relay answered 503')),
        () => {
          throw new Error('thrown before any promise');
        },
      ] as RelayReleaser['release'][]) {
        const d = await sessionDeps({ release });
        await d.index.putRuntime('sid-fixed', { sandboxPod: 'moca-sandbox-0' });
        expect((await del(d)).status).toBe(204);
        expect(await d.index.get('sid-fixed')).toBeNull();
        await vi.waitFor(() => expect(lines(d)).toHaveLength(1));
        expect(lines(d)[0]).toMatchObject({ outcome: 'not_answered' });
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('never sends a release when the delete itself fails', async () => {
    const { releaser, calls } = fakeReleaser();
    const d = await sessionDeps(releaser);
    await d.index.putRuntime('sid-fixed', { sandboxPod: 'moca-sandbox-0' });
    d.index.cascadeDelete = async () => {
      throw new Error('redis down');
    };
    await expect(del(d)).rejects.toThrow('redis down');
    await tick();
    expect(calls).toEqual([]);
  });

  it('returns before a release that never answers settles, not at the bound', async () => {
    quiet();
    const d = await sessionDeps({ release: () => new Promise(() => {}) }); // the default 5 s bound
    await d.index.putRuntime('sid-fixed', { sandboxPod: 'moca-sandbox-0' });
    const t0 = Date.now();
    expect((await del(d)).status).toBe(204);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('makes no extra runtime read and writes no audit line without a releaser', async () => {
    const d = await sessionDeps();
    const spy = vi.spyOn(d.index, 'getRuntime');
    await del(d);
    // The in-flight hint's own read, as before.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(lines(d)).toEqual([]);
  });
});
