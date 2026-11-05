import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectResources, resolveSandbox } from '../src/resources.js';
import { HANDLERS } from '../src/handlers.js';
import { makeDeps, ctx, alice, bob, codeOf, seedCredential } from './helpers/deps.js';
import type { RunKubectl } from '../src/kubectl.js';
import { defaultRunKubectl } from '../src/kubectl.js';
import { OwnershipIndex, type SessionRecord } from '../src/ownership.js';
import { fakeRedis } from './helpers/fake-redis.js';

const rec: SessionRecord = {
  sessionId: 'sid-1',
  owner: 'github:1234',
  tenant: 'github:1234',
  createdAt: 1_757_000_000_000,
  state: 'active',
  poolSelector: null,
  credentialName: 'my-anthropic',
  configRef: null,
  tombstone: false,
};

describe('resolveSandbox', () => {
  it('uses the pinned pod name when the harness reported one', async () => {
    const calls: string[][] = [];
    const run: RunKubectl = async (args) => {
      calls.push(args);
      return 'Running';
    };
    expect(
      await resolveSandbox({ sandboxPod: 'sandbox-0-0' }, 'default', run, 'github:1234'),
    ).toEqual({ podName: 'sandbox-0-0', phase: 'Running', tenant: 'github:1234' });
    expect(calls[0]).toContain('sandbox-0-0');
  });

  it('resolves from the selector when no pod was pinned', async () => {
    // The /turn path resolves a single pod inside run-turn.ts and never leases from the pool
    // (spec §8.2), so the selector is usually all the harness can self-report (plan gap #5).
    const run: RunKubectl = async (args) =>
      args.includes('-l') ? 'sandbox-1-0\tRunning' : 'Running';
    expect(
      await resolveSandbox(
        { sandboxSelector: 'sh.kagenti.io/sandbox-pool=default' },
        'default',
        run,
        'github:1234',
      ),
    ).toEqual({ podName: 'sandbox-1-0', phase: 'Running', tenant: 'github:1234' });
  });

  it('defaults the phase to unknown when the selector reply carries no tab', async () => {
    // resolveSandbox splits the selector reply on '\t'. A reply with only a name -- a custom-columns
    // template that lost a column, or a single-field output -- leaves phase '' and it must read as
    // 'unknown' rather than as an empty string a client would render as a blank status.
    const run: RunKubectl = async () => 'sandbox-1-0';
    expect(
      await resolveSandbox(
        { sandboxSelector: 'sh.kagenti.io/sandbox-pool=default' },
        'default',
        run,
        'github:1234',
      ),
    ).toEqual({ podName: 'sandbox-1-0', phase: 'unknown', tenant: 'github:1234' });
  });

  it('reports unknown when the harness reported neither', async () => {
    let called = false;
    const run: RunKubectl = async () => {
      called = true;
      throw new Error('should not be called');
    };
    expect(await resolveSandbox({}, 'default', run, 'github:1234')).toEqual({
      podName: null,
      phase: 'unknown',
      tenant: 'github:1234',
    });
    expect(
      called,
      'resolveSandbox must not invoke kubectl when neither a pinned pod nor a selector was reported',
    ).toBe(false);
  });

  it('reports unknown rather than 500 when the Kubernetes API is down', async () => {
    // For an introspection endpoint, partial data with explicit unknowns beats an error (spec §9.2).
    const run: RunKubectl = async () => {
      throw new Error('The connection to the server was refused');
    };
    expect(
      await resolveSandbox({ sandboxPod: 'sandbox-0-0' }, 'default', run, 'github:1234'),
    ).toEqual({ podName: 'sandbox-0-0', phase: 'unknown', tenant: 'github:1234' });
  });

  it('reports unknown when the pod is gone (an empty --ignore-not-found reply)', async () => {
    const run: RunKubectl = async () => '';
    expect(await resolveSandbox({ sandboxPod: 'gone' }, 'default', run, 'github:1234')).toEqual({
      podName: 'gone',
      phase: 'unknown',
      tenant: 'github:1234',
    });
  });

  it('reports unknown when no runner is configured at all', async () => {
    expect(await resolveSandbox({ sandboxPod: 'p' }, 'default', undefined, 'github:1234')).toEqual({
      podName: 'p',
      phase: 'unknown',
      tenant: 'github:1234',
    });
  });

  it('reports unknown, not a crash, on a host with no kubectl at all (deploy/vm)', async () => {
    // The REAL runner, with a PATH that has no kubectl: spawn fails with ENOENT. On a VM this is every
    // call to /v1/sessions/{id}/resources, so it must degrade exactly like a Kubernetes outage.
    const saved = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), 'no-kubectl-'));
    try {
      expect(
        await resolveSandbox(
          { sandboxPod: 'sandbox-0-0' },
          'default',
          defaultRunKubectl,
          'github:1234',
        ),
      ).toEqual({ podName: 'sandbox-0-0', phase: 'unknown', tenant: 'github:1234' });
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('projectResources', () => {
  it('returns spec §7.4`s shape', async () => {
    const out = projectResources(
      rec,
      { harnessPod: 'h-1', revision: 'r-1', lastTurnAt: '1757000001000', turns: '3' },
      { podName: 'sandbox-0-0', phase: 'Running', tenant: 'github:1234' },
    ) as Record<string, Record<string, unknown>>;
    expect(out.session).toEqual({
      id: 'sid-1',
      state: 'active',
      createdAt: 1_757_000_000_000,
      lastTurnAt: 1_757_000_001_000,
      turns: 3,
      sandboxTier: null,
    });
    expect(out.harness).toEqual({ mode: 'worker', podName: 'h-1', revision: 'r-1', ready: true });
    expect(out.sandbox).toEqual({
      podName: 'sandbox-0-0',
      phase: 'Running',
      tenant: 'github:1234',
    });
    // MU1's /turn path does not lease from the pool and has no queue position; null rather than a
    // fabricated zero, so MU2 filling these in is visibly a change (spec §8.2).
    expect(out.lease).toBeNull();
    expect(out.queue).toBeNull();
  });

  it('reports a worker harness and a lease when the runtime hash carries one', async () => {
    const out = projectResources(
      rec,
      { harnessPod: 'worker-abc', leaseKey: 'sh:sandbox:sandbox-0-0:leases' },
      { podName: 'sandbox-0-0', phase: 'Running', tenant: 'github:1234' },
    ) as Record<string, Record<string, unknown> | null>;
    expect(out.harness!.mode).toBe('worker');
    expect(out.lease).toMatchObject({ key: 'sh:sandbox:sandbox-0-0:leases' });
    expect(out.lease).not.toHaveProperty('runId');
  });

  it('reports ready:false and a null pod when the harness never self-reported', async () => {
    // Nothing wrote a runtime hash between turns. That is a legitimate state, not an
    // error: the session exists, and no pod is serving it right now.
    const out = projectResources(
      rec,
      {},
      { podName: null, phase: 'unknown', tenant: 'github:1234' },
    ) as Record<string, Record<string, unknown>>;
    expect(out.harness).toEqual({ mode: null, podName: null, revision: null, ready: false });
    expect(out.session.turns).toBe(0);
    expect(out.session.lastTurnAt).toBeNull();
  });

  it('projects placement from the runtime report, and the session tier from the record (P6.3)', () => {
    // Tiered: on an untiered deployment a stored tier is not shown (viewTier, spec §3.3).
    const tiers = { names: ['container', 'microvm'], default: 'container' };
    const out = projectResources(
      { ...rec, sandboxTier: 'microvm' },
      {
        sandboxId: 'm-1',
        sandboxTier: 'microvm',
        workspaceResetAt: '1757000002000',
        workspaceResetFrom: 'm-0',
      },
      { podName: null, phase: 'unknown', tenant: 'github:1234' },
      tiers,
    ) as Record<string, Record<string, unknown> | null>;
    expect(out.session!.sandboxTier).toBe('microvm');
    expect(out.placement).toEqual({
      sandboxId: 'm-1',
      tier: 'microvm',
      workspaceReset: { at: 1_757_000_002_000, from: 'm-0' },
    });
  });

  it('placement is null until a leased turn has reported, and workspaceReset null until a reset', () => {
    const none = projectResources(
      rec,
      {},
      { podName: null, phase: 'unknown', tenant: 't' },
    ) as Record<string, unknown>;
    expect(none.placement).toBeNull();
    const plain = projectResources(
      rec,
      { sandboxId: 'c-0', sandboxTier: '' },
      { podName: null, phase: 'unknown', tenant: 't' },
    ) as Record<string, Record<string, unknown>>;
    expect(plain.placement).toEqual({ sandboxId: 'c-0', tier: null, workspaceReset: null });
    // Self-reported, so untrusted: a garbage time is no reset we can show, never `at: NaN`.
    const garbage = projectResources(
      rec,
      { sandboxId: 'c-1', workspaceResetAt: 'not-a-time', workspaceResetFrom: 'c-0' },
      { podName: null, phase: 'unknown', tenant: 't' },
    ) as Record<string, Record<string, unknown>>;
    expect(garbage.placement).toEqual({ sandboxId: 'c-1', tier: null, workspaceReset: null });
  });

  it("shows today's default tier for a session recorded before P6.3, like the session view", () => {
    // `rec` has no sandboxTier field at all: written before P6.3. The exchange hands such a session
    // today's default, so that is the tier it actually runs in -- and what the view must show.
    const tiers = { names: ['container', 'microvm'], default: 'container' };
    const out = projectResources(
      rec,
      {},
      { podName: null, phase: 'unknown', tenant: 't' },
      tiers,
    ) as Record<string, Record<string, unknown>>;
    expect(out.session!.sandboxTier).toBe('container');
  });

  it("shows today's default for a record stored with '', matching its placement", () => {
    // '' was stored while the deployment declared no tiers. The exchange leaves the tier out for
    // it, and the data plane gives it today's default -- so session.sandboxTier must agree with
    // placement.tier rather than contradict it with null.
    const tiers = { names: ['container', 'microvm'], default: 'container' };
    const out = projectResources(
      { ...rec, sandboxTier: '' },
      { sandboxId: 'c-0', sandboxTier: 'container' },
      { podName: null, phase: 'unknown', tenant: 't' },
      tiers,
    ) as Record<string, Record<string, unknown>>;
    expect(out.session!.sandboxTier).toBe('container');
    expect(out.placement!.tier).toBe('container');
    // Null only when the deployment declares no tiers at all.
    const untiered = projectResources(
      { ...rec, sandboxTier: '' },
      {},
      { podName: null, phase: 'unknown', tenant: 't' },
      null,
    ) as Record<string, Record<string, unknown>>;
    expect(untiered.session!.sandboxTier).toBeNull();
  });

  it('shows null for a tier stored while tiers were declared, once the deployment declares none', () => {
    const out = projectResources(
      { ...rec, sandboxTier: 'microvm' },
      {},
      { podName: null, phase: 'unknown', tenant: 't' },
      null,
    ) as Record<string, Record<string, unknown>>;
    expect(out.session!.sandboxTier).toBeNull();
  });

  it('never echoes a runtime field the harness invented', async () => {
    // The hash is written by the brain tier, so the projection emits only fields it knows about --
    // an `owner` written there must not surface as though the control plane had blessed it (§7.4).
    const out = JSON.stringify(
      projectResources(rec, { owner: 'github:attacker', evil: 'x' } as never, {
        podName: null,
        phase: 'unknown',
        tenant: 'github:1234',
      }),
    );
    expect(out).not.toContain('attacker');
    expect(out).not.toContain('evil');
  });
});

describe('GET /v1/sessions/{id}/resources', () => {
  it('is owner-gated like every other session route', async () => {
    const d = makeDeps();
    await seedCredential(d);
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d);
    await expect(
      HANDLERS.getSessionResources!(ctx({ principal: alice, params: { id: 'sid-fixed' } }), d),
    ).resolves.toMatchObject({ status: 200 });
    expect(
      await codeOf(() =>
        HANDLERS.getSessionResources!(ctx({ principal: bob, params: { id: 'sid-fixed' } }), d),
      ),
    ).toBe('session_not_found');
  });

  it('returns Redis-sourced fields with sandbox.phase unknown when kubectl fails', async () => {
    const d = makeDeps({
      runKubectl: async () => {
        throw new Error('connection refused');
      },
    });
    await seedCredential(d);
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d);
    await d.index.putRuntime('sid-fixed', { harnessPod: 'h-1', sandboxPod: 'sandbox-0-0' });
    const res = await HANDLERS.getSessionResources!(
      ctx({ principal: alice, params: { id: 'sid-fixed' } }),
      d,
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, Record<string, unknown>>;
    expect(body.harness!.podName).toBe('h-1');
    expect(body.sandbox!.phase).toBe('unknown');
  });

  it('shows a null session tier on an untiered deployment, whatever the record stored', async () => {
    const tiers = { names: ['container', 'microvm'], default: 'container' };
    const d = makeDeps({ config: { sandboxTiers: tiers } });
    await seedCredential(d);
    await HANDLERS.createSession!(
      ctx({ principal: alice, body: { sandbox: { tier: 'microvm' } } }),
      d,
    );
    expect((await d.index.get('sid-fixed'))!.sandboxTier).toBe('microvm');
    const res = await HANDLERS.getSessionResources!(
      ctx({ principal: alice, params: { id: 'sid-fixed' } }),
      { ...d, config: { ...d.config, sandboxTiers: null } },
    );
    expect((res.body as Record<string, Record<string, unknown>>).session!.sandboxTier).toBeNull();
  });

  it("shows a pre-P6.3 session's tier as today's default, and its self-reported placement", async () => {
    const f = fakeRedis();
    const d = makeDeps({
      index: new OwnershipIndex(f.redis),
      config: { sandboxTiers: { names: ['container', 'microvm'], default: 'container' } },
    });
    await seedCredential(d);
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d);
    // Strip the field createSession stored: a record written before P6.3 has none at all.
    const key = [...f.hashes.keys()].find((k) => f.hashes.get(k)?.sandboxTier !== undefined)!;
    delete f.hashes.get(key)!.sandboxTier;
    expect((await d.index.get('sid-fixed'))!.sandboxTier).toBeUndefined();
    await d.index.putRuntime('sid-fixed', {
      sandboxId: 'c-1',
      sandboxTier: 'container',
      workspaceResetAt: '1757000002000',
      workspaceResetFrom: 'c-0',
    });
    const res = await HANDLERS.getSessionResources!(
      ctx({ principal: alice, params: { id: 'sid-fixed' } }),
      d,
    );
    const body = res.body as Record<string, Record<string, unknown>>;
    expect(body.session!.sandboxTier).toBe('container');
    expect(body.placement).toEqual({
      sandboxId: 'c-1',
      tier: 'container',
      workspaceReset: { at: 1_757_000_002_000, from: 'c-0' },
    });
  });
});
