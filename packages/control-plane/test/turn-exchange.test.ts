import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { AUDIT_STREAM, OwnershipIndex, sessionKey } from '../src/ownership.js';
import type { TurnRecord, TurnState } from '../src/turn-record.js';
import { TurnStore } from '../src/turn-store.js';
import { exchangeCredential } from '../src/exchange.js';
import { exchangeTurnCredential } from '../src/turn-exchange.js';
import { alice, codeOf, ctx, makeDeps, NOW_MS, seedCredential } from './helpers/deps.js';
import { fakeRedis } from './helpers/fake-redis.js';

/**
 * The DEQUEUE-time credential exchange (async fan-out spec §5.4, MI1 §6.5). The property this file
 * exists for is the one the queue cannot prove on its own: a worker holding ONLY a turn id gets
 * everything it needs to run that leaf, and a worker holding a turn id it should not be able to spend
 * gets a named refusal instead of a credential.
 */

/**
 * Deps with a real OwnershipIndex and a real TurnStore over ONE fake Redis, as turn-handlers.test.ts
 * does. `streams` must follow the overridden `index` or every audit assertion would read a
 * permanently empty map and could never fail (the hazard makeDeps documents).
 */
function exDeps(over: Record<string, unknown> = {}) {
  const fake = fakeRedis();
  let n = 0;
  const deps = makeDeps({
    index: new OwnershipIndex(fake.redis),
    streams: fake.streams,
    newId: () => `id-${++n}`,
    ...over,
  });
  const turns = new TurnStore(fake.redis, { resultTtlSeconds: 86_400, ttlMarginSeconds: 3_600 });
  return { ...deps, turns, fake } as typeof deps & {
    turns: TurnStore;
    fake: ReturnType<typeof fakeRedis>;
  };
}

type ExDeps = ReturnType<typeof exDeps>;

/** A session owned by alice, through the real handler, so the record is the one the exchange reads. */
async function session(d: ExDeps, credential = 'my-anthropic'): Promise<string> {
  await seedCredential(d, 'github:1234', credential);
  const res = await HANDLERS.createSession!(
    ctx({ principal: alice, body: { credentials: { inference: credential } } }),
    d,
  );
  return (res.body as { sessionId: string }).sessionId;
}

/**
 * A queued turn on `sid`, written through the store, copying owner/credential/model/tier as
 * submitTurn does. The end-to-end proof that submitTurn copies them is the acceptance test at the
 * bottom of this file, which goes through the real handler rather than this helper.
 */
async function queuedTurn(d: ExDeps, sid: string, over: Partial<TurnRecord> = {}): Promise<string> {
  const rec = (await d.index.get(sid))!;
  const turn: TurnRecord = {
    turnId: 't-1',
    owner: rec.owner,
    tenant: rec.tenant,
    sessionId: sid,
    cfg: rec.configRef ?? '',
    credentialName: rec.credentialName,
    model: rec.model ?? '',
    ...(rec.modelLimits ? { modelLimits: rec.modelLimits } : {}),
    sandboxTier: rec.sandboxTier ?? '',
    caps: { tokens: 500, wallClock: 120 },
    idempotencyKey: sid,
    envelope: { item: { item_id: 'i1', file: 'f.ts', pattern: 'p' } },
    state: 'queued',
    attempts: 0,
    createdAt: NOW_MS,
    ...over,
  };
  await d.turns.create(turn);
  return turn.turnId;
}

describe('exchangeTurnCredential (async spec §5.4)', () => {
  it('resolves the record s credential NAME into the credential the turn spends', async () => {
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid);

    const res = await exchangeTurnCredential(turnId, d);

    // Direct mode, because the fixture configures no injector -- so the real secret comes back, and
    // this assertion is what proves the NAME on the record was RESOLVED rather than echoed.
    expect(res.mode).toBe('direct');
    expect(res.anthropicAuthToken).toBe('sk-fake'); // notsecret
    expect(res.anthropicBaseUrl).toBe('https://litellm.internal/v1');
    expect(res.sessionId).toBe(sid);
    expect(res.subject).toBe('github:1234');
    expect(res.turnId).toBe(turnId);
    // The caps the submission recorded, handed to the worker that will enforce them (#389).
    expect(res.caps).toEqual({ tokens: 500, wallClock: 120 });
  });

  it('returns a placeholder, never the secret, when the deployment has an injector', async () => {
    const d = exDeps({ config: { injectorConfigured: true } });
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid);

    const res = await exchangeTurnCredential(turnId, d);

    // Placeholder mode WINS wherever an injector exists, exactly as the session exchange decides it:
    // adding an injector must narrow what a worker holds on BOTH paths, or async would be the hole in
    // a deployment that believed it had closed one.
    expect(res.mode).toBe('placeholder');
    expect(res.anthropicAuthToken).toBe('sh-placeholder-github:1234');
    expect(JSON.stringify(res)).not.toContain('sk-fake'); // notsecret
  });

  it('leaves the turn in `queued`: this call reads, it does not claim', async () => {
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid);

    await exchangeTurnCredential(turnId, d);

    // The state transition is the CONSUMER's (#389, via TurnStore.markRunning). A shared-bearer
    // endpoint that wrote `running` would let any holder of SH_EXCHANGE_TOKEN flip an arbitrary turn
    // out of `queued` -- and since cancel() accepts `queued` only, make it uncancellable.
    const after = await d.turns.get(turnId);
    expect(after?.state).toBe('queued');
    expect(after?.attempts).toBe(0);
    // ...and no TTL either. A non-terminal record carries none (§5.1), and `expires` is the fake's
    // record of every EXPIRE issued, so this fails if the exchange ever starts a clock on the record.
    expect(d.fake.expires).toEqual([]);
  });

  it('404s a turn id with no record, and an empty one', async () => {
    const d = exDeps();
    expect(await codeOf(() => exchangeTurnCredential('t-nobody', d))).toBe('turn_not_found');
    // '' must not read a hash at all: turnKey('') is a real key, and a partial write under it would
    // otherwise answer as a turn. `get` already refuses a hash with no `owner`; this pins the caller.
    expect(await codeOf(() => exchangeTurnCredential('', d))).toBe('turn_not_found');
  });

  it('refuses a cancelled turn, so a withdrawal is honoured at claim (§4.5)', async () => {
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid);
    expect(await d.turns.cancel(turnId, NOW_MS)).toBe('cancelled');

    // §4.5's withdrawal is enforced HERE. The queue entry survives the cancel -- nothing removes it --
    // so the only thing that can stop the leaf running is the claim refusing it a credential.
    expect(await codeOf(() => exchangeTurnCredential(turnId, d))).toBe('turn_not_claimable');
  });

  it('refuses every terminal state and ADMITS `running`, which is what a redelivery looks like', async () => {
    const terminal: TurnState[] = ['paused', 'responded', 'done', 'solved', 'failed', 'lost'];
    for (const state of terminal) {
      const d = exDeps();
      const sid = await session(d);
      const turnId = await queuedTurn(d, sid, { state });
      expect(await codeOf(() => exchangeTurnCredential(turnId, d)), state).toBe(
        'turn_not_claimable',
      );
    }

    // `running` is NOT terminal and must be admitted. The first claim writes it, so a crash-reclaimed
    // (§6.2), drained (§6.3) or `retryable` entry always arrives on a record that already says
    // `running`: refusing those would ack and drop exactly the entries crash recovery exists for, and
    // strand the record in `running` with no TTL and no entry for the reaper (§5.4).
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid, { state: 'running', attempts: 2 });
    const res = await exchangeTurnCredential(turnId, d);
    expect(res.turnId).toBe(turnId);
    expect(res.anthropicAuthToken).toBe('sk-fake'); // notsecret
  });

  it('does not test `attempts`: exhaustion is the QUEUE s call, not the record s (§5.4)', async () => {
    const d = exDeps();
    const sid = await session(d);
    // A redelivered turn with a high attempt count still gets its credential. `deliveryCount` on the
    // queue entry is the single authority on exhaustion, checked by the consumer's dead-letter branch
    // BEFORE it ever calls here; a second limit read off the record could disagree with it and would
    // strand a turn the queue still intends to deliver.
    const turnId = await queuedTurn(d, sid, { state: 'running', attempts: 99 });
    expect((await exchangeTurnCredential(turnId, d)).turnId).toBe(turnId);
  });

  it('404s when the turn s session is gone, with the SESSION s own code', async () => {
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid);
    await d.index.cascadeDelete((await d.index.get(sid))!);

    // `session_not_found`, not `turn_not_found`: the turn record is intact and the SESSION is what is
    // missing, so the code names what actually failed. Reachable because deleteSessionTurns reclaims
    // OPEN turns on cascade but a cascade that crashed mid-way, or a record written outside that path,
    // must still refuse rather than resolve a credential against a session that no longer exists.
    expect(await codeOf(() => exchangeTurnCredential(turnId, d))).toBe('session_not_found');
  });

  it('404s a tombstoned session, so a DELETED session cannot start a leaf', async () => {
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid);
    await d.index.tombstone(sid);

    // The same check the session exchange makes, and it matters MORE here: a tombstoned session's
    // queued entries are still on the stream, so without this a DELETE /v1/sessions/{id} would be
    // followed by its leaves running anyway, each one spending the owner's credential.
    expect(await codeOf(() => exchangeTurnCredential(turnId, d))).toBe('session_not_found');
  });

  it('404s when the record s owner is not the session s owner', async () => {
    const d = exDeps();
    const sid = await session(d);
    // A record naming a session it does not belong to. Stored state from a bug or a tampered write,
    // never something a caller can produce through submitTurn -- and the owner compare is what stops
    // it resolving ANOTHER subject's credential, because resolveInference reads `owner` off the TURN.
    // Without this check a turn record is a request for whoever's key it names.
    const turnId = await queuedTurn(d, sid, { owner: 'github:9999', tenant: 'github:9999' });
    expect(await codeOf(() => exchangeTurnCredential(turnId, d))).toBe('session_not_found');
  });

  it('refuses under MOCA_TENANCY=multi, by name (the M1 interim gate, §9.1)', async () => {
    const d = exDeps({ config: { tenancy: 'multi' } });
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid);

    // MI1 §6.6: direct mode is reachable only under `single`, and "under `multi` the exchange returns
    // grants or refuses; it never returns a real key". This slice mints no grants, so it refuses.
    // Asserted even though submitTurn already refuses `multi`: that refusal stops NEW submissions,
    // while a deployment flipped to `multi` with entries already on the queue would otherwise drain
    // them down the single-tenant path this gate exists to forbid.
    expect(await codeOf(() => exchangeTurnCredential(turnId, d))).toBe('async_tenancy_unsupported');
  });

  it('refuses `multi` BEFORE resolving anything, so no credential is read on that path', async () => {
    const d = exDeps({ config: { tenancy: 'multi' } });
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid);
    // The order is the point, not the code: a gate that fires after resolveInference has already
    // fetched the secret has read a credential it is forbidden to return. Proven by removing the
    // credential -- the answer stays the tenancy refusal rather than becoming credential_required.
    await d.credentials.delete('github:1234', 'my-anthropic');
    expect(await codeOf(() => exchangeTurnCredential(turnId, d))).toBe('async_tenancy_unsupported');
  });

  it('propagates the credential refusals unchanged, rather than falling back to anyone s key', async () => {
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid, { credentialName: 'deleted-since' });
    // resolveInference's own refusal, reused verbatim: a turn whose named credential is gone must not
    // quietly run on the operator's key, and must not get a different code on the async path than the
    // interactive one gives for the same cause.
    expect(await codeOf(() => exchangeTurnCredential(turnId, d))).toBe('credential_required');
  });

  it('refuses a MISDIRECTED secret rather than handing the worker a key its endpoint cannot read', async () => {
    const RAW_KEY = 'sk-ant-api03-not-a-real-key'; // notsecret
    const d = exDeps();
    // A raw Anthropic API key whose endpoint resolves to a gateway. Direct mode would send the key
    // itself to a host that is not api.anthropic.com -- a misdirected secret (spec §6.2, #368), and
    // the one failure on this path that costs a user their key rather than only failing the turn.
    await seedCredential(d, 'github:1234', 'misdirected', {
      kind: 'api-key',
      destination: { hosts: ['api.anthropic.com'] },
      endpoint: 'https://litellm.internal/v1',
      secret: { key: RAW_KEY },
    });
    const res = await HANDLERS.createSession!(
      ctx({ principal: alice, body: { credentials: { inference: 'misdirected' } } }),
      d,
    );
    const sid = (res.body as { sessionId: string }).sessionId;
    const turnId = await queuedTurn(d, sid);

    // Asserted on the ASYNC path specifically. The check lives in exchange.ts and is SHARED, so the
    // session-path tests (exchange-auth-header.test.ts) pass whether or not this function calls it:
    // removing the call here leaves this file's other 16 tests and the whole suite green. This test is
    // what fails if a future edit -- #389 is the first caller -- drops it.
    let message = '';
    try {
      await exchangeTurnCredential(turnId, d);
      throw new Error('the exchange returned a credential for a misdirected secret');
    } catch (e) {
      message = (e as Error).message;
      expect((e as { code: string }).code).toBe('credential_required');
    }
    // The message names the credential and the endpoint it should have, never the key itself: this
    // refusal is logged, and a secret in a log outlives the incident that produced it (§7.2).
    expect(message).toContain("'misdirected'");
    expect(message).not.toContain(RAW_KEY);
  });

  it('audits the credential NAME, the turn and the subject — never the value (§7.2)', async () => {
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid);

    await exchangeTurnCredential(turnId, d);

    const entries = d.fake.streams.get(AUDIT_STREAM) ?? [];
    const issued = entries.filter((e) => e.decision === 'credential_issued');
    expect(issued.length).toBe(1);
    expect(issued[0]).toMatchObject({
      subject: 'github:1234',
      sessionId: sid,
      turnId,
      credential: 'my-anthropic',
      decision: 'credential_issued',
    });
    // The WHOLE stream, not only this entry: the audit is the one artifact an operator reads after a
    // leak, and a secret in it is a leak that outlives the incident.
    expect(JSON.stringify(entries)).not.toContain('sk-fake'); // notsecret
  });

  it('audits nothing, and returns nothing, on a refusal', async () => {
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid);
    await d.index.tombstone(sid);

    await codeOf(() => exchangeTurnCredential(turnId, d));

    // No `credential_issued` for a credential that was never issued. The audit is read as the record
    // of what a worker holds, so an entry written on the refusal path would overstate it.
    const entries = d.fake.streams.get(AUDIT_STREAM) ?? [];
    expect(entries.filter((e) => e.decision === 'credential_issued')).toEqual([]);
  });

  it('answers 500 (internal_error) and returns NO credential when the audit write fails', async () => {
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid);
    // Not best-effort, and deliberately unlike the submission routes' auditBestEffort: those audit a
    // write that ALREADY happened, so swallowing keeps a repair path open during an outage. Here the
    // audit is the only record that a credential left the control plane, so a credential issued
    // without one must not happen. The same rule the session exchange follows.
    d.index.audit = async () => {
      throw new Error('redis is down');
    };
    expect(await codeOf(() => exchangeTurnCredential(turnId, d))).toBe('internal_error');
  });

  it('answers a named internal_error when the store is not wired, rather than throwing a TypeError on undefined', async () => {
    const d = exDeps();
    // depsFromEnv always builds the store, so this is a wiring bug and not a caller error -- the same
    // reading turn-handlers.service() applies, and it must not surface as a TypeError.
    const noStore = { ...d, turns: undefined };
    expect(await codeOf(() => exchangeTurnCredential('t-1', noStore))).toBe('internal_error');
  });
});

describe('the envelope in the response', () => {
  it('returns the stored envelope with the record session id attached', async () => {
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid, {
      envelope: { item: { item_id: 'i-1', file: 'a.ts', pattern: 'x' } },
    });
    const res = await exchangeTurnCredential(turnId, d);
    expect(res.envelope).toEqual({
      item: { item_id: 'i-1', file: 'a.ts', pattern: 'x' },
      sessionId: sid,
    });
  });

  it('the record session id wins over one stored in the envelope', async () => {
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid, {
      envelope: { kind: 'prompt', prompt: 'go', sessionId: 'not-this-one' },
    });
    const res = await exchangeTurnCredential(turnId, d);
    expect(res.envelope.sessionId).toBe(sid);
  });

  it('carries no credential of any kind', async () => {
    const d = exDeps();
    const sid = await session(d);
    const turnId = await queuedTurn(d, sid);
    const res = await exchangeTurnCredential(turnId, d);
    const keys = Object.keys(res.envelope);
    expect(keys).not.toContain('credentialName');
    expect(keys).not.toContain('anthropicAuthToken');
    expect(JSON.stringify(res.envelope)).not.toContain(res.anthropicAuthToken);
  });
});

/**
 * A queued turn of a templated session runs on that template's workers, pinned to its build and
 * seeded, exactly as an interactive one does: the dequeue exchange returns what the session
 * exchange returns (session-templates spec §3.4, combined control plane spec §3.4).
 */
describe("the session's sandbox template on the dequeue exchange", () => {
  const PY312 = { id: 'py312', worker: 'w-py', description: '', tools: [], seed: 'echo hi' };
  const B = 'sha256:' + 'b'.repeat(64);

  async function templatedSession(d: ExDeps, template: string): Promise<string> {
    await seedCredential(d, 'github:1234', 'my-anthropic');
    const res = await HANDLERS.createSession!(
      ctx({
        principal: alice,
        body: { credentials: { inference: 'my-anthropic' }, sandbox: { template } },
      }),
      d,
    );
    return (res.body as { sessionId: string }).sessionId;
  }

  it('returns a declared template and its seed, as the session exchange does', async () => {
    const d = exDeps({ config: { sessionTemplates: [PY312] } });
    const sid = await templatedSession(d, 'py312');
    const res = await exchangeTurnCredential(await queuedTurn(d, sid), d);
    expect(res).toMatchObject({
      sandboxTemplate: 'py312',
      sandboxSeed: 'echo hi',
      sandboxSeedSource: 'declared',
    });
    expect(res).not.toHaveProperty('sandboxBuildId');
  });

  it("returns a pinned session's build and that build's own seed", async () => {
    const d = exDeps({
      config: { sessionTemplates: [PY312] },
      templates: {
        get: async (id: string) =>
          id === 'py312'
            ? { builds: [{ buildId: B, spec: { seed: 'cp -a /opt/src/. /workspace/' } }] }
            : null,
      } as never,
    });
    const sid = await templatedSession(d, 'py312');
    // The build the session resolved at creation (written once, as createSession does with a store).
    await d.fake.redis.hSet(sessionKey(sid), { sandboxBuildId: B });
    const res = await exchangeTurnCredential(await queuedTurn(d, sid), d);
    expect(res).toMatchObject({
      sandboxTemplate: 'py312',
      sandboxBuildId: B,
      sandboxSeed: 'cp -a /opt/src/. /workspace/',
      sandboxSeedSource: 'build',
    });
  });

  it("refuses, issuing nothing, when the store cannot read a pinned session's build", async () => {
    const d = exDeps({
      config: { sessionTemplates: [PY312] },
      templates: {
        get: async () => {
          throw new Error('EIO');
        },
      } as never,
    });
    await seedCredential(d, 'github:1234', 'my-anthropic');
    const created = await HANDLERS.createSession!(
      ctx({
        principal: alice,
        body: { credentials: { inference: 'my-anthropic' }, sandbox: { template: 'py312' } },
      }),
      d,
    );
    const { sessionId: sid, token } = created.body as { sessionId: string; token: string };
    await d.fake.redis.hSet(sessionKey(sid), { sandboxBuildId: B });
    const turnId = await queuedTurn(d, sid);
    const before = (d.fake.streams.get(AUDIT_STREAM) ?? []).length;
    const err = console.error;
    console.error = () => {};
    try {
      // Not the declared seed: a self-serve build has none there, so a fallback would run the turn
      // on an unseeded workspace. A refusal the data plane retries (the claim leaves it pending).
      expect(await codeOf(() => exchangeTurnCredential(turnId, d))).toBe('internal_error');
      expect(await codeOf(() => exchangeCredential(token, d))).toBe('internal_error');
    } finally {
      console.error = err;
    }
    const entries = (d.fake.streams.get(AUDIT_STREAM) ?? []).slice(before);
    expect(entries.filter((e) => e.decision === 'credential_issued')).toEqual([]);
  });

  it('falls back to the declared seed when the store holds no such build', async () => {
    const d = exDeps({
      config: { sessionTemplates: [PY312] },
      templates: { get: async () => null } as never,
    });
    const sid = await templatedSession(d, 'py312');
    await d.fake.redis.hSet(sessionKey(sid), { sandboxBuildId: B });
    const res = await exchangeTurnCredential(await queuedTurn(d, sid), d);
    expect(res).toMatchObject({ sandboxSeed: 'echo hi', sandboxSeedSource: 'declared' });
  });

  it('still names a template the deployment no longer declares, without a seed (fail closed)', async () => {
    const d = exDeps({ config: { sessionTemplates: [PY312] } });
    const sid = await templatedSession(d, 'py312');
    const gone = { ...d, config: { ...d.config, sessionTemplates: [] } };
    const res = await exchangeTurnCredential(await queuedTurn(d, sid), gone);
    expect(res.sandboxTemplate).toBe('py312');
    expect(res).not.toHaveProperty('sandboxSeed');
  });

  it('returns none of them for an untemplated session', async () => {
    const d = exDeps({ config: { sessionTemplates: [PY312] } });
    const sid = await session(d);
    const res = await exchangeTurnCredential(await queuedTurn(d, sid), d);
    for (const k of ['sandboxTemplate', 'sandboxSeed', 'sandboxSeedSource', 'sandboxBuildId'])
      expect(res).not.toHaveProperty(k);
  });
});

/**
 * #388: the turn runs on the model and tier its SUBMISSION chose. Through the real handlers
 * end-to-end -- `submitTurn` rather than `queuedTurn` -- because what is being tested is the copy
 * onto the record, which a helper that writes the fields itself would pass with the copy removed.
 */
describe('a queued turn is pinned to its submission (#388)', () => {
  const INFO = {
    data: [
      {
        model_name: 'claude-opus-4-8',
        model_info: { max_input_tokens: 200000, max_output_tokens: 32000 },
      },
      {
        model_name: 'cheap-model',
        model_info: { max_input_tokens: 8000, max_output_tokens: 1000 },
      },
    ],
  };
  const gateway = (async (url: string) =>
    url.endsWith('/model/info')
      ? new Response(JSON.stringify(INFO), { status: 200 })
      : new Response('', { status: 404 })) as unknown as typeof fetch;

  /** Deps with a model catalog, and tiers declared so `sandboxTier` is not dropped. */
  const modelDeps = () =>
    exDeps({
      fetchImpl: gateway,
      config: {
        modelCatalogHosts: ['litellm.internal'],
        sandboxTiers: { names: ['container', 'microvm'], default: 'container' },
      },
    });

  async function submittedTurn(d: ExDeps, sid: string): Promise<string> {
    const res = await HANDLERS.submitTurn!(
      ctx({
        principal: alice,
        params: { id: sid },
        body: { async: true, item: { item_id: 'i1', file: 'f.ts', pattern: 'p' } },
      }),
      d,
    );
    return (res.body as { turnId: string }).turnId;
  }

  it('keeps the model it was submitted with after a PATCH switches the session', async () => {
    const d = modelDeps();
    await seedCredential(d, 'github:1234', 'my-anthropic');
    await HANDLERS.createSession!(
      ctx({
        principal: alice,
        body: { credentials: { inference: 'my-anthropic' }, model: 'claude-opus-4-8' },
      }),
      d,
    );
    const turnId = await submittedTurn(d, 'id-1');

    // The switch a caller is free to make while the turn waits on the queue. `updateSession`'s own
    // rule is that a turn already RUNNING keeps its model -- which cannot cover this turn, because
    // it has not started: its exchange may be an hour from now.
    await HANDLERS.updateSession!(
      ctx({ principal: alice, params: { id: 'id-1' }, body: { model: 'cheap-model' } }),
      d,
    );
    expect((await d.index.get('id-1'))?.model).toBe('cheap-model');

    const res = await exchangeTurnCredential(turnId, d);
    // The SUBMITTED model, with the SUBMITTED limits. Both, together: the limits describe the
    // model, so `maxTokens: 1000` against `claude-opus-4-8` would send the wrong `max_tokens`
    // upstream for every message of the turn.
    expect(res.model).toEqual({
      id: 'claude-opus-4-8',
      contextWindow: 200000,
      maxTokens: 32000,
    });
  });

  it('keeps the tier it was submitted with, and falls back to the session when it pinned none', async () => {
    const d = modelDeps();
    await seedCredential(d, 'github:1234', 'my-anthropic');
    await HANDLERS.createSession!(
      ctx({
        principal: alice,
        body: { credentials: { inference: 'my-anthropic' }, sandbox: { tier: 'microvm' } },
      }),
      d,
    );
    const pinned = await submittedTurn(d, 'id-1');
    // These two hold whether the exchange reads the record or the session, because a session's tier
    // is immutable: `updateSession` refuses every field but `model`. They pin the COPY, which is the
    // half of this that could regress -- the read is guarded by the untiered case below.
    expect((await d.turns.get(pinned))?.sandboxTier).toBe('microvm');
    expect((await exchangeTurnCredential(pinned, d)).sandboxTier).toBe('microvm');

    // A record written before #388 carries no tier, and reads back as ''. It must resolve against
    // the SESSION, not against the deployment default: handing this worker 'container' while the
    // session runs on 'microvm' retiers the session's sandbox, and a retier starts its workspace
    // empty. A session created while no tiers were declared stores '' too, so that case resolves to
    // the deployment default through the same line -- `sessionTier`'s own suite covers it.
    const untiered = await queuedTurn(d, 'id-1', { turnId: 't-untiered', sandboxTier: '' });
    expect((await exchangeTurnCredential(untiered, d)).sandboxTier).toBe('microvm');
  });
});
