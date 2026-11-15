import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaseNotice } from '@moca/sandbox-client';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, errorFromResponse } from '../src/api/errors.js';
import { openSbxRuntime, sbxMain } from '../src/sbx/cli.js';
import type { SbxHost } from '../src/sbx/api.js';
import { refusalText, SBX_EXIT } from '../src/sbx/commands.js';
import { dryRun } from '../src/sbx/dry-run.js';
import {
  cmdActivate,
  cmdRetire,
  RETIRE_TIMEOUT_S,
  sizedActivateTimeoutS,
} from '../src/sbx/templates.js';
import {
  cleanupTmp,
  fakeCp,
  leaseEnd,
  withLeaseEvents,
  policyView,
  sandbox,
  SBX,
  setup,
  TOKEN,
  URL_,
  workspaces,
  type Handler,
} from './helpers/sbx.js';

// The template commands of mocactl (template lifecycle spec §4, §8): `sbx templates` with readiness
// and tags, `templates show`, `create --template ID[@BUILD] --seed`, and the authoring commands
// (`quota`, `policy`, `templates create|build|follow|cancel`, `--dry-run`); and activation (§6.3):
// `templates activate` and `templates deactivate`; and the hosts' slots and memory (§6.2):
// `sbx hosts`, and why an unavailable build waits; and cold-start pacing (§6.5): the start line, the
// sized `activate --wait`, the idle grace and `deactivate --stop-now`; and retire (§5.1):
// `templates retire`. example.com hosts only.

afterEach(cleanupTmp);

const BUILD_ID = `sha256:${'b'.repeat(64)}`;
const IMPORTED = 'imported:0123456789ab';
const build = (over: Record<string, unknown> = {}) => ({
  buildId: BUILD_ID,
  status: 'registered',
  profile: 'base',
  readiness: 'inactive',
  capacity: null,
  lastUsedAt: null,
  tags: ['default'],
  createdAt: 1_800_000_000,
  provenance: `sha256:${'c'.repeat(64)}`,
  ...over,
});
const template = (over: Record<string, unknown> = {}) => ({
  id: 'my-python',
  description: 'Python 3.12',
  tools: ['bash'],
  owner: 'github:1',
  visibility: 'private',
  onboarding: 'registered',
  readiness: 'inactive',
  tags: { default: BUILD_ID },
  builds: [build()],
  ...over,
});

/** A fake clock the waits run on: sleep advances it. */
function clock() {
  let t = 1_800_000_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

function world(routes: Record<string, Handler>) {
  const s = setup();
  const cp = fakeCp(routes);
  const c = clock();
  const run = (argv: string[], over: Record<string, unknown> = {}) => {
    s.io.outs.length = 0;
    s.io.errs.length = 0;
    return sbxMain(argv, s.env, s.io, {
      home: s.home,
      fetchImpl: cp.fetchImpl,
      sleep: c.sleep,
      now: c.now,
      ...over,
    });
  };
  return {
    ...s,
    cp,
    clock: c,
    run,
    out: () => s.io.outs.join(''),
    err: () => s.io.errs.join('\n'),
  };
}

describe('sbx templates: readiness and tags', () => {
  it('shows each template with its readiness and tags', async () => {
    const w = world({
      'GET /v1/templates': () => ({
        status: 200,
        body: {
          templates: [
            template({ readiness: 'active', tags: { default: BUILD_ID, stable: BUILD_ID } }),
            template({ id: 'node22', description: 'Node 22', readiness: 'unknown' }),
          ],
          hosts: [],
        },
      }),
    });
    expect(await w.run(['templates'])).toBe(0);
    expect(w.out()).toContain('my-python        active    Python 3.12  tags default,stable\n');
    expect(w.out()).toContain('node22           unknown   Node 22  tags default\n');
  });
});

describe('templates show', () => {
  it('a template and its builds, or one build, with readiness, capacity and tags', async () => {
    const w = world({
      'GET /v1/templates/my-python': () => ({
        status: 200,
        body: template({
          owner: null,
          visibility: 'deployment',
          readiness: 'active',
          builds: [
            build({ readiness: 'active', capacity: { running: 3, inUse: 1 } }),
            build({ buildId: IMPORTED, status: 'failed', readiness: null, tags: [] }),
          ],
        }),
      }),
      [`GET /v1/templates/my-python/builds/${encodeURIComponent(BUILD_ID)}`]: () => ({
        status: 200,
        body: build({ spec: { seed: 'true', tools: ['bash'] } }),
      }),
    });
    expect(await w.run(['templates', 'show', 'my-python'])).toBe(0);
    expect(w.out()).toContain('my-python  owner the deployment  deployment  registered  active\n');
    expect(w.out()).toContain(
      `  ${BUILD_ID}  registered  active (running 3, in use 1)  tags default\n`,
    );
    expect(w.out()).toContain(`  ${IMPORTED}  failed\n`);
    expect(await w.run(['templates', 'show', 'my-python', '--build', BUILD_ID])).toBe(0);
    expect(w.out()).toBe(`${BUILD_ID}  registered  inactive  tags default\n`);
    expect(await w.run(['templates', 'show', 'my-python', '--build', BUILD_ID, '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toMatchObject({ spec: { seed: 'true' } });
  });

  it('names why an unavailable build waits (readinessReason), on the template and the build', async () => {
    const w = world({
      'GET /v1/templates/my-python': () => ({
        status: 200,
        body: template({
          readiness: 'unavailable',
          readinessReason: 'memory',
          builds: [build({ readiness: 'unavailable', readinessReason: 'memory' })],
        }),
      }),
    });
    expect(await w.run(['templates', 'show', 'my-python'])).toBe(0);
    expect(w.out()).toContain('registered  unavailable (memory)\n');
    expect(w.out()).toContain(`  ${BUILD_ID}  registered  unavailable (memory)  tags default\n`);
  });

  it('says where a build waits in its host start line, or that it is in its idle grace', async () => {
    const OTHER = `sha256:${'d'.repeat(64)}`;
    const w = world({
      'GET /v1/templates/my-python': () => ({
        status: 200,
        body: template({
          readiness: 'activating',
          builds: [
            build({ readiness: 'activating', queued: true, queuePosition: 6 }),
            build({
              buildId: OTHER,
              readiness: 'deactivating',
              graced: true,
              gracedUntil: 1_800_000_600,
              tags: [],
            }),
          ],
        }),
      }),
    });
    expect(await w.run(['templates', 'show', 'my-python'])).toBe(0);
    expect(w.out()).toContain(
      `  ${BUILD_ID}  registered  activating (queued at 6)  tags default\n`,
    );
    expect(w.out()).toContain(
      `  ${OTHER}  registered  deactivating (graced until ${new Date(1_800_000_600_000).toISOString()})\n`,
    );
  });

  it('reports 404 template_not_found as itself, not as a control plane without sandbox routes', async () => {
    const w = world({
      'GET /v1/templates/nope': () => ({
        status: 404,
        body: { error: 'template_not_found', message: 'no such template' },
      }),
    });
    expect(await w.run(['templates', 'show', 'nope'])).toBe(1);
    expect(w.err()).toContain('no such template');
    expect(w.err()).not.toContain('no sandbox routes');
  });

  it('refuses bad usage locally, before any request', async () => {
    const w = world({});
    for (const argv of [
      ['templates', 'show'],
      ['templates', 'show', 'a', 'b'],
      ['templates', 'nope'],
      ['templates', '--build', BUILD_ID],
      ['ls', '--build', BUILD_ID],
      ['templates', 'show', 'a', '--build', ' '],
      ['ls', '--seed'],
    ]) {
      expect(await w.run(argv), argv.join(' ')).toBe(2);
    }
    expect(w.cp.calls).toEqual([]);
  });
});

describe('create --template id@build, --seed', () => {
  it('passes create --template id@build through as given', async () => {
    const w = world({
      'POST /v1/sandboxes': (req) => ({
        status: 201,
        body: sandbox({ template: (req.body as { template: string }).template }),
      }),
    });
    expect(await w.run(['create', '--template', `my-python@${BUILD_ID}`])).toBe(0);
    expect(w.cp.calls.at(-1)!.body).toEqual({ template: `my-python@${BUILD_ID}` });
  });

  const seeded = (
    seed: string | undefined,
    more: Parameters<typeof world>[0] = {},
    served = BUILD_ID,
  ) => {
    const ws = workspaces();
    const w = world({
      ...more,
      'POST /v1/sandboxes': () => ({
        status: 201,
        body: {
          ...sandbox({ template: 'my-python' }),
          buildId: served,
          templateManifestHash: served.startsWith('sha256:') ? served : null,
        },
      }),
      'GET /v1/templates/my-python': () => ({
        status: 200,
        body: template({
          builds: [
            build({ spec: { ...(seed !== undefined ? { seed } : {}), tools: ['bash'] } }),
            build({
              buildId: IMPORTED,
              tags: [],
              spec: { seed: 'echo the other build; exit 9', tools: ['bash'] },
            }),
          ],
        }),
      }),
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
    });
    return { w, ws, run: (argv: string[]) => w.run(argv, { execFactory: ws.factory }) };
  };
  const GIT_SEED =
    'git init -q /workspace && cd /workspace && echo hi > a && git add a && ' +
    'git -c user.email=t@example.invalid -c user.name=t -c commit.gpgSign=false commit -qm base';

  it('--seed says the lease events its Execs carried (plan-4 M2)', async () => {
    const s = seeded(GIT_SEED);
    const end = leaseEnd({ reason: 'idle' });
    expect(
      await s.w.run(['create', '--template', 'my-python', '--seed'], {
        execFactory: withLeaseEvents(s.ws.factory, [[end]]),
      }),
    ).toBe(0);
    expect(s.w.io.errs).toContain(leaseNotice(end, Date.now()));
  });

  it('--seed: runs the seed first, then finds a clean tree and its HEAD', async () => {
    const s = seeded(GIT_SEED);
    expect(await s.run(['create', '--template', 'my-python', '--seed', '--json'])).toBe(0);
    const out = JSON.parse(s.w.out()) as { seed: { clean: boolean; head: string } };
    expect(out.seed).toMatchObject({ seed: GIT_SEED, exitCode: 0, clean: true });
    expect(out.seed.head).toMatch(/^[0-9a-f]{40}$/);
    expect(s.ws.get(SBX).sent[0]!.command).toBe(GIT_SEED);
    expect(s.w.err()).toContain(`seeded ${SBX}: a clean tree at ${out.seed.head}`);
  });

  it('--seed: runs the seed of the build the create was served, not the default one', async () => {
    const s = seeded(GIT_SEED, {}, IMPORTED);
    expect(await s.run(['create', '--template', `my-python@${IMPORTED}`, '--seed'])).toBe(1);
    expect(s.ws.get(SBX).sent[0]!.command).toBe('echo the other build; exit 9');
    expect(s.w.err()).toContain('the seed exited 9');
  });

  it("--seed: the seed's clean tree becomes the baseline, so a plain rm deletes it (no unpulled changes)", async () => {
    let deleted = 0;
    const s = seeded(GIT_SEED, {
      [`DELETE /v1/sandboxes/${SBX}`]: () => {
        deleted++;
        return {
          status: 200,
          body: { ...sandbox({ template: 'my-python' }), state: 'terminated' },
        };
      },
    });
    expect(await s.run(['create', '--template', 'my-python', '--seed'])).toBe(0);
    expect(await s.run(['rm', SBX])).toBe(0);
    expect(deleted).toBe(1);
    expect(s.w.err()).not.toContain('not yet pulled');
  });

  it('--seed: a failing seed, a dirty tree, or a build with no seed is exit 1; an empty seed runs nothing', async () => {
    let s = seeded('exit 3');
    expect(await s.run(['create', '--template', 'my-python', '--seed'])).toBe(1);
    expect(s.w.err()).toContain('the seed exited 3');
    expect(s.w.out()).toBe(`${SBX}\n`);
    s = seeded(`${GIT_SEED} && echo x > b`);
    expect(await s.run(['create', '--template', 'my-python', '--seed'])).toBe(1);
    expect(s.w.err()).toContain('has 1 changed or untracked paths: not a clean tree');
    s = seeded(undefined);
    expect(await s.run(['create', '--template', 'my-python', '--seed', '--json'])).toBe(1);
    expect(JSON.parse(s.w.out())).toMatchObject({
      id: SBX,
      seed: { error: 'the build of my-python names no seed' },
    });
    s = seeded('');
    expect(await s.run(['create', '--template', 'my-python', '--seed'])).toBe(0);
    expect(s.w.err()).toContain('the template has no seed');
    expect(s.ws.get(SBX).sent).toEqual([]);
  });
});

describe('sbx templates activate and deactivate (§6.3)', () => {
  const LEASE = {
    templateId: 'my-python',
    buildId: BUILD_ID,
    leaseUntil: 1_800_003_600,
    host: 'host-1',
  };

  it('takes a lease, naming the build and its length, and prints it', async () => {
    const w = world({
      'POST /v1/templates/my-python/activate': () => ({ status: 200, body: LEASE }),
    });
    expect(
      await w.run(['templates', 'activate', 'my-python', '--build', BUILD_ID, '--lease', '600']),
    ).toBe(0);
    expect(w.cp.calls.at(-1)!.body).toEqual({ build: BUILD_ID, leaseSeconds: 600 });
    expect(w.out()).toBe(
      `my-python ${BUILD_ID} leased until ${new Date(1_800_003_600_000).toISOString()} on host-1\n`,
    );
    expect(await w.run(['templates', 'activate', 'my-python', '--json'])).toBe(0);
    expect(w.cp.calls.at(-1)!.body).toEqual({});
    expect(JSON.parse(w.out())).toEqual(LEASE);
  });

  it('releases the leases', async () => {
    const w = world({
      'POST /v1/templates/my-python/deactivate': () => ({
        status: 200,
        body: { templateId: 'my-python', released: 1 },
      }),
    });
    expect(await w.run(['templates', 'deactivate', 'my-python'])).toBe(0);
    expect(w.out()).toBe('my-python: released 1 lease\n');
    expect(w.cp.calls.at(-1)!.body).toEqual({});
  });

  it('--stop-now: releases with stopNow, skipping the host idle grace, and says so', async () => {
    const w = world({
      'POST /v1/templates/my-python/deactivate': () => ({
        status: 200,
        body: { templateId: 'my-python', released: 1 },
      }),
    });
    expect(await w.run(['templates', 'deactivate', 'my-python', '--stop-now'])).toBe(0);
    expect(w.cp.calls.at(-1)!.body).toEqual({ stopNow: true });
    expect(w.out()).toBe('my-python: released 1 lease, stopped now (no idle grace)\n');
    const calls = w.cp.calls.length;
    for (const argv of [
      ['templates', 'activate', 'my-python', '--stop-now'],
      ['hosts', '--stop-now'],
    ]) {
      expect(await w.run(argv), argv.join(' ')).toBe(2);
    }
    expect(w.cp.calls).toHaveLength(calls);
  });

  it('fails a refused activation at once, naming the refusal', async () => {
    const w = world({
      'POST /v1/templates/my-python/activate': () => ({
        status: 409,
        body: {
          error: 'template_unavailable',
          message: "no host holds this build's snapshot",
          readiness: 'unavailable',
        },
      }),
    });
    expect(await w.run(['templates', 'activate', 'my-python', '--wait'])).toBe(1);
    expect(w.err()).toContain("no host holds this build's snapshot");
    expect(w.cp.calls.filter((c) => c.path.includes('/activate'))).toHaveLength(1);
  });

  it('refuses a bad --lease, --wait or --timeout where they do not apply, and a missing ID', async () => {
    const w = world({});
    for (const argv of [
      ['templates', 'activate', 'my-python', '--lease', '30'],
      ['templates', 'activate', 'my-python', '--lease', '1h'],
      ['templates', 'show', 'my-python', '--wait'],
      ['templates', 'activate', 'my-python', '--timeout', '60'],
      ['templates', 'deactivate', 'my-python', '--build', BUILD_ID],
      ['templates', 'activate'],
      ['templates', 'deactivate', 'a', 'b'],
      ['create', '--lease', '600'],
    ]) {
      expect(await w.run(argv), argv.join(' ')).toBe(2);
    }
    expect(w.cp.calls).toHaveLength(0);
  });

  /** cmdActivate on a scripted control plane, with a fake clock: what it slept and said. */
  function waiting(routes: Record<string, Handler>) {
    const s = setup();
    const cp = fakeCp(routes);
    const { rt, api } = openSbxRuntime(URL_, s.env, { home: s.home, fetchImpl: cp.fetchImpl });
    const slept: number[] = [];
    let t = 0;
    rt.sleep = async (ms: number) => {
      slept.push(ms);
      t += ms;
    };
    rt.now = () => t;
    return { ...s, cp, slept, c: { rt, api, url: URL_, io: s.io, json: false } };
  }

  it('--wait: retries no_active_slot after its Retry-After, then reads the build until active, saying why it waits', async () => {
    let tries = 0;
    let reads = 0;
    const w = waiting({
      'POST /v1/templates/my-python/activate': () =>
        ++tries < 2
          ? {
              status: 409,
              body: { error: 'no_active_slot', message: 'full', readiness: 'unavailable' },
              headers: { 'retry-after': '20' },
            }
          : { status: 200, body: LEASE },
      [`GET /v1/templates/my-python/builds/${encodeURIComponent(BUILD_ID)}`]: () => ({
        status: 200,
        body: build({ readiness: ++reads < 3 ? 'activating' : 'active' }),
      }),
    });
    expect(await cmdActivate(w.c, 'my-python', { wait: true })).toBe(SBX_EXIT.ok);
    expect(w.slept).toEqual([20_000, 5000, 5000]);
    const errs = w.io.errs.join('');
    expect(errs).toContain('my-python: waiting: no active slot');
    // Said once, however many reads say the same.
    expect(errs.match(/waiting: activating: its host is starting its worker/g)).toHaveLength(1);
    expect(w.io.outs.join('')).toContain(`my-python ${BUILD_ID} active, leased until`);
  });

  it('--wait: says when it waits for memory, from the refusal and from the build', async () => {
    let tries = 0;
    let reads = 0;
    const w = waiting({
      'POST /v1/templates/my-python/activate': () =>
        ++tries < 2
          ? {
              status: 409,
              body: {
                error: 'no_active_slot',
                message: 'no memory',
                readiness: 'unavailable',
                reason: 'memory',
              },
              headers: { 'retry-after': '20' },
            }
          : { status: 200, body: LEASE },
      [`GET /v1/templates/my-python/builds/${encodeURIComponent(BUILD_ID)}`]: () => ({
        status: 200,
        body:
          ++reads < 2
            ? build({ readiness: 'unavailable', readinessReason: 'memory' })
            : build({ readiness: 'active' }),
      }),
    });
    expect(await cmdActivate(w.c, 'my-python', { wait: true })).toBe(SBX_EXIT.ok);
    const errs = w.io.errs.join('');
    expect(errs).toContain(
      'my-python: waiting: no host holding it has the memory for its worker now',
    );
    expect(errs).toContain(
      'my-python: waiting: unavailable: no host holding it has the memory for its worker now',
    );
    expect(errs).not.toContain('no active slot');
  });

  it('sizes --wait from the start line: (ceil(position / concurrency) + 1) start times plus a quarter, 1800 s to 4 h', () => {
    const host = (concurrency: number, seconds: number | null) =>
      ({ id: 'host-1', start: { concurrency, seconds, starting: 4, queued: 16 } }) as SbxHost;
    // Position 20 behind 4 at a time, 300 s a start: (5 + 1) x 300 x 1.25.
    expect(sizedActivateTimeoutS({ queued: true, queuePosition: 20 }, host(4, 300))).toBe(2250);
    expect(sizedActivateTimeoutS({ queued: true, queuePosition: 2 }, host(4, 300))).toBe(1800);
    expect(sizedActivateTimeoutS({ queued: true, queuePosition: 20 }, host(4, null))).toBe(1800);
    expect(sizedActivateTimeoutS({ queued: false }, host(4, 300))).toBe(1800);
    expect(sizedActivateTimeoutS(undefined, undefined)).toBe(1800);
    // A host reporting an outlier start time (hours) is capped at 4 h.
    expect(sizedActivateTimeoutS({ queued: true, queuePosition: 20 }, host(4, 7200))).toBe(14_400);
  });

  it("--wait with no --timeout: sized from the host's start line, saying so; --timeout wins", async () => {
    const hosts = {
      templates: [],
      hosts: [
        {
          id: 'host-1',
          active: { limit: 20, used: 20 },
          idleLimitSeconds: 3600,
          disk: { freeGb: 400, floorGb: 60 },
          start: { concurrency: 4, seconds: 300, starting: 4, queued: 16 },
        },
      ],
    };
    const routes = {
      'POST /v1/templates/my-python/activate': () => ({ status: 200, body: LEASE }),
      'GET /v1/templates': () => ({ status: 200, body: hosts }),
      [`GET /v1/templates/my-python/builds/${encodeURIComponent(BUILD_ID)}`]: () => ({
        status: 200,
        body: build({ readiness: 'activating', queued: true, queuePosition: 20 }),
      }),
    };
    let w = waiting(routes);
    expect(await cmdActivate(w.c, 'my-python', { wait: true })).toBe(SBX_EXIT.timedOut);
    let errs = w.io.errs.join('');
    expect(errs).toContain('my-python: queued at 20; waiting up to 2250 s');
    expect(errs).toContain("waiting: activating: queued at 20 in its host's start line");
    expect(errs).toContain('timed out after 2250 s');
    expect(w.slept.reduce((a, b) => a + b, 0)).toBe(2_250_000);
    w = waiting(routes);
    expect(await cmdActivate(w.c, 'my-python', { wait: true, timeoutS: 60 })).toBe(
      SBX_EXIT.timedOut,
    );
    errs = w.io.errs.join('');
    expect(errs).not.toContain('waiting up to');
    expect(errs).toContain('timed out after 60 s');
    expect(w.cp.calls.some((c) => c.method === 'GET' && c.path === '/v1/templates')).toBe(false);
  });

  it('--wait: exits 5 when the build is not active within --timeout', async () => {
    const w = waiting({
      'POST /v1/templates/my-python/activate': () => ({ status: 200, body: LEASE }),
      [`GET /v1/templates/my-python/builds/${encodeURIComponent(BUILD_ID)}`]: () => ({
        status: 200,
        body: build({ readiness: 'activating' }),
      }),
    });
    expect(await cmdActivate(w.c, 'my-python', { wait: true, timeoutS: 12 })).toBe(
      SBX_EXIT.timedOut,
    );
    expect(w.slept).toEqual([5000, 5000, 2000]);
    expect(w.io.errs.join('')).toContain('timed out after 12 s');
  });
});

describe('sbx templates retire (§5.1)', () => {
  const HANDLE = 'b-0123456789abcdef0123456789';
  const RECORD = `sha256:${'d'.repeat(64)}`;
  const retiredBuild = (record: string | null = RECORD) => ({
    build: HANDLE,
    buildId: BUILD_ID,
    readiness: 'retired',
    record,
  });
  const BUILD_PATH = `GET /v1/templates/my-python/builds/${HANDLE}`;

  it('retires a template with a reason, and prints each build; one already retired says so', async () => {
    const w = world({
      'POST /v1/templates/my-python/retire': () => ({
        status: 200,
        body: {
          templateId: 'my-python',
          subject: 'github:1',
          status: 'retired',
          builds: [retiredBuild(), { ...retiredBuild(null), build: 'b-old' }],
        },
      }),
    });
    expect(await w.run(['templates', 'retire', 'my-python', '--reason', 'superseded'])).toBe(0);
    expect(w.cp.calls.at(-1)!.body).toEqual({ reason: 'superseded' });
    expect(w.out()).toBe(
      `retired my-python ${HANDLE}\nretired my-python b-old (already retired)\n`,
    );
    expect(await w.run(['templates', 'retire', 'my-python', '--json'])).toBe(0);
    expect(w.cp.calls.at(-1)!.body).toEqual({});
    expect(JSON.parse(w.out())).toMatchObject({ templateId: 'my-python', status: 'retired' });
  });

  it('retires one build with --build, by DELETE', async () => {
    const w = world({
      [`DELETE /v1/templates/my-python/builds/${HANDLE}`]: () => ({
        status: 200,
        body: {
          templateId: 'my-python',
          subject: 'github:1',
          status: 'retired',
          ...retiredBuild(),
        },
      }),
    });
    expect(await w.run(['templates', 'retire', 'my-python', '--build', HANDLE])).toBe(0);
    expect(w.cp.calls.at(-1)!.method).toBe('DELETE');
    expect(w.out()).toBe(`retired my-python ${HANDLE}\n`);
  });

  it('fails a refused retire, naming the refusal', async () => {
    const w = world({
      'POST /v1/templates/my-python/retire': () => ({
        status: 409,
        body: { error: 'build_in_use', message: `build ${HANDLE} still serves a live sandbox` },
      }),
    });
    expect(await w.run(['templates', 'retire', 'my-python', '--wait'])).toBe(1);
    expect(w.err()).toContain('still serves a live sandbox');
    expect(w.cp.calls).toHaveLength(1);
  });

  it('says in words that a retired template is never served again', async () => {
    const w = world({
      'POST /v1/sandboxes': () => ({
        status: 410,
        body: { error: 'template_retired', message: "template 'my-python' is retired" },
      }),
    });
    expect(await w.run(['create', '--template', 'my-python'])).toBe(1);
    expect(w.err()).toContain("template 'my-python' is retired");
    expect(w.err()).toContain('never served again');
  });

  it('refuses --reason with --build or elsewhere, and --timeout without --wait', async () => {
    const w = world({});
    for (const argv of [
      ['templates', 'retire', 'my-python', '--build', HANDLE, '--reason', 'x'],
      ['templates', 'show', 'my-python', '--reason', 'x'],
      ['templates', 'retire', 'my-python', '--timeout', '60'],
      ['templates', 'retire', 'my-python', '--lease', '600'],
      ['templates', 'retire'],
    ]) {
      expect(await w.run(argv), argv.join(' ')).toBe(2);
    }
    expect(w.cp.calls).toHaveLength(0);
  });

  /** cmdRetire on a scripted control plane, with a fake clock: what it slept and said. */
  function waiting(routes: Record<string, Handler>) {
    const s = setup();
    const cp = fakeCp(routes);
    const { rt, api } = openSbxRuntime(URL_, s.env, { home: s.home, fetchImpl: cp.fetchImpl });
    const slept: number[] = [];
    let t = 0;
    rt.sleep = async (ms: number) => {
      slept.push(ms);
      t += ms;
    };
    rt.now = () => t;
    return { ...s, cp, slept, c: { rt, api, url: URL_, io: s.io, json: false } };
  }
  const retireRoute = () => ({
    status: 200,
    body: {
      templateId: 'my-python',
      subject: 'github:1',
      status: 'retired',
      builds: [retiredBuild()],
    },
  });

  const RUNNING = { running: 3, inUse: 1 };
  const retiredRead = (capacity: unknown, heldBy: unknown = ['host-1']) =>
    build({ status: 'retired', readiness: 'retired', capacity, heldBy });

  it('--wait: reads the build until its worker stops and its host removes it, saying each step once', async () => {
    let reads = 0;
    const w = waiting({
      'POST /v1/templates/my-python/retire': retireRoute,
      // Two reads running, two stopped but still held, then removed from every host.
      [BUILD_PATH]: () => {
        ++reads;
        return {
          status: 200,
          body: retiredRead(reads < 3 ? RUNNING : null, reads < 5 ? ['host-1'] : []),
        };
      },
    });
    expect(await cmdRetire(w.c, 'my-python', { wait: true })).toBe(SBX_EXIT.ok);
    expect(w.slept).toEqual([5000, 5000, 5000, 5000]);
    const errs = w.io.errs.join('');
    // Said once, however many reads say the same.
    expect(errs.match(/retired, its worker still runs \(1 in use\)/g)).toHaveLength(1);
    expect(errs.match(/retired, its worker stopped; still held by host-1/g)).toHaveLength(1);
    expect(errs).toContain(
      `my-python ${HANDLE}: retired, its worker stopped and removed from every host`,
    );
  });

  it("--wait: keeps waiting while its worker's state cannot be read (running null)", async () => {
    let reads = 0;
    const w = waiting({
      'POST /v1/templates/my-python/retire': retireRoute,
      [BUILD_PATH]: () => ({
        status: 200,
        body: ++reads < 3 ? retiredRead({ running: null, inUse: null }) : retiredRead(null, []),
      }),
    });
    expect(await cmdRetire(w.c, 'my-python', { wait: true })).toBe(SBX_EXIT.ok);
    expect(w.slept).toEqual([5000, 5000]);
    const errs = w.io.errs.join('');
    expect(errs.match(/its worker's state cannot be read; still waiting/g)).toHaveLength(1);
    expect(errs).toContain('retired, its worker stopped and removed from every host');
  });

  it('--wait: done at once without host agents (heldBy null)', async () => {
    const w = waiting({
      'POST /v1/templates/my-python/retire': retireRoute,
      [BUILD_PATH]: () => ({ status: 200, body: retiredRead(RUNNING, null) }),
    });
    expect(await cmdRetire(w.c, 'my-python', { wait: true })).toBe(SBX_EXIT.ok);
    expect(w.slept).toEqual([]);
    expect(w.io.errs.join('')).toContain(
      `my-python ${HANDLE}: retired; no host agent holds it, so its worker is not host-managed`,
    );
    expect(w.io.errs.join('')).not.toContain('removed from every host');
  });

  it('--wait: done at once when no host holds the build (heldBy empty, worker attached)', async () => {
    // Host agents exist, but none holds this build (an imported template's operator-run worker):
    // none will stop its worker, so waiting could only time out.
    for (const capacity of [RUNNING, { running: null, inUse: null }]) {
      const w = waiting({
        'POST /v1/templates/my-python/retire': retireRoute,
        [BUILD_PATH]: () => ({ status: 200, body: retiredRead(capacity, []) }),
      });
      expect(await cmdRetire(w.c, 'my-python', { wait: true })).toBe(SBX_EXIT.ok);
      expect(w.slept).toEqual([]);
      const errs = w.io.errs.join('');
      expect(errs).toContain('no host agent holds it, so its worker is not host-managed');
      expect(errs).not.toContain('its worker still runs');
    }
  });

  it('--wait: done at once when heldBy is empty from the start and its worker stopped', async () => {
    const w = waiting({
      'POST /v1/templates/my-python/retire': retireRoute,
      [BUILD_PATH]: () => ({ status: 200, body: retiredRead(null, []) }),
    });
    expect(await cmdRetire(w.c, 'my-python', { wait: true })).toBe(SBX_EXIT.ok);
    expect(w.slept).toEqual([]);
    const errs = w.io.errs.join('');
    expect(errs).toContain(`my-python ${HANDLE}: retired, its worker stopped`);
    expect(errs).not.toContain('removed from every host');
  });

  it('--wait: a build its host held waits for its stop too once heldBy empties', async () => {
    // Held at first, then no host holds it while its worker still runs: not done until it stops,
    // and never taken for a build no host agent manages.
    let reads = 0;
    const w = waiting({
      'POST /v1/templates/my-python/retire': retireRoute,
      [BUILD_PATH]: () => {
        ++reads;
        return {
          status: 200,
          body: retiredRead(reads < 3 ? RUNNING : null, reads < 2 ? ['host-1'] : []),
        };
      },
    });
    expect(await cmdRetire(w.c, 'my-python', { wait: true })).toBe(SBX_EXIT.ok);
    expect(w.slept).toEqual([5000, 5000]);
    const errs = w.io.errs.join('');
    expect(errs).not.toContain('not host-managed');
    expect(errs).toContain(
      `my-python ${HANDLE}: retired, its worker stopped and removed from every host`,
    );
  });

  it('--wait: done at once for a shared build, its worker kept for a build not retired', async () => {
    // Two builds of one template from one image share a worker id; the other is still wanted.
    const w = waiting({
      'POST /v1/templates/my-python/retire': retireRoute,
      [BUILD_PATH]: () => ({ status: 200, body: { ...retiredRead(null), shared: true } }),
    });
    expect(await cmdRetire(w.c, 'my-python', { wait: true })).toBe(SBX_EXIT.ok);
    expect(w.slept).toEqual([]);
    const errs = w.io.errs.join('');
    expect(errs).toContain(
      `my-python ${HANDLE}: retired; its worker also serves a build that is not retired`,
    );
    expect(errs).not.toContain('its worker stopped');
  });

  it('--wait: exits 5 when its worker still runs at --timeout', async () => {
    const w = waiting({
      'POST /v1/templates/my-python/retire': retireRoute,
      [BUILD_PATH]: () => ({ status: 200, body: retiredRead(RUNNING) }),
    });
    expect(await cmdRetire(w.c, 'my-python', { wait: true, timeoutS: 12 })).toBe(SBX_EXIT.timedOut);
    expect(w.slept).toEqual([5000, 5000, 2000]);
    expect(w.io.errs.join('')).toContain(
      `timed out after 12 s waiting for my-python ${HANDLE} to stop its worker and be removed from every host`,
    );
  });

  it('--wait: exits 5 when a host still holds it at --timeout, its worker stopped', async () => {
    const w = waiting({
      'POST /v1/templates/my-python/retire': retireRoute,
      [BUILD_PATH]: () => ({ status: 200, body: retiredRead(null, ['host-1', 'host-2']) }),
    });
    expect(await cmdRetire(w.c, 'my-python', { wait: true, timeoutS: 6 })).toBe(SBX_EXIT.timedOut);
    expect(w.slept).toEqual([5000, 1000]);
    const errs = w.io.errs.join('');
    expect(errs.match(/retired, its worker stopped; still held by host-1, host-2/g)).toHaveLength(
      1,
    );
    expect(errs).toContain('to stop its worker and be removed from every host');
  });
});

describe('sbx hosts (§6.2)', () => {
  const HOST = {
    id: 'host-1',
    active: { limit: 8, used: 3 },
    idleLimitSeconds: 3600,
    disk: { freeGb: 400, floorGb: 60 },
  };
  const MEMORY = {
    totalMib: 65536,
    availableMib: 40000,
    floorMib: 6553,
    usedMib: 12672,
    headroomMib: 33447,
    pressureFull10: 0.1,
    pressureLimit: 10,
    brake: null,
    runningWorkers: 3,
    memfileMismatch: [],
    reportedAt: 1_800_000_000,
  };

  it('prints each host: active slots, memory headroom and floor (with a brake), disk', async () => {
    const w = world({
      'GET /v1/templates': () => ({
        status: 200,
        body: {
          templates: [],
          hosts: [
            { ...HOST, memory: MEMORY },
            {
              ...HOST,
              id: 'host-2',
              memory: { ...MEMORY, headroomMib: 0, brake: 'stale', memfileMismatch: [BUILD_ID] },
            },
            { ...HOST, id: 'host-3' },
          ],
        },
      }),
    });
    expect(await w.run(['hosts'])).toBe(0);
    expect(w.out()).toBe(
      'host-1           active 3 of 8; memory 33447 MiB headroom of 65536 (floor 6553); disk 400 GB free (floor 60)\n' +
        'host-2           active 3 of 8; memory 0 MiB headroom of 65536 (floor 6553), brake: stale, 1 memory file mismatch; disk 400 GB free (floor 60)\n' +
        'host-3           active 3 of 8; disk 400 GB free (floor 60)\n',
    );
    expect(await w.run(['hosts', '--json'])).toBe(0);
    expect(JSON.parse(w.out())[0]).toEqual({ ...HOST, memory: MEMORY });
  });

  it('prints the start line and the idle grace, from an agent that reports them', async () => {
    const w = world({
      'GET /v1/templates': () => ({
        status: 200,
        body: {
          templates: [],
          hosts: [
            {
              ...HOST,
              start: { concurrency: 4, seconds: 40.4, starting: 4, queued: 2 },
              idleGraceSeconds: 600,
              graced: 1,
            },
            {
              ...HOST,
              id: 'host-2',
              start: { concurrency: 2, seconds: null, starting: null, queued: null },
            },
          ],
        },
      }),
    });
    expect(await w.run(['hosts'])).toBe(0);
    expect(w.out()).toBe(
      'host-1           active 3 of 8; start 4 starting, 2 queued (at most 4 at once, 40 s each); grace 600 s (1 graced); disk 400 GB free (floor 60)\n' +
        'host-2           active 3 of 8; start ? starting, ? queued (at most 2 at once); disk 400 GB free (floor 60)\n',
    );
  });

  it('says when no host has reported, and refuses an argument', async () => {
    const w = world({
      'GET /v1/templates': () => ({ status: 200, body: { templates: [], hosts: [] } }),
    });
    expect(await w.run(['hosts'])).toBe(0);
    expect(w.out()).toBe('no host has reported yet\n');
    const calls = w.cp.calls.length;
    expect(await w.run(['hosts', 'host-1'])).toBe(2);
    expect(w.cp.calls).toHaveLength(calls);
  });
});

// The authoring commands: create, build, follow, cancel, quota, policy, and --dry-run.
const DIGEST = `sha256:${'a'.repeat(64)}`;
const IMAGE = `team/moca-microvm@${DIGEST}`;
const SPEC = {
  schema: 'moca-sbx-template-spec/1',
  id: 'my-python',
  image: IMAGE,
  guest_ram_mb: 4096,
  vcpus: 2,
  egress: false,
  seed: '',
  tools: ['bash', 'git', 'python3'],
  probe: { cmd: 'python3 -V', timeout_s: 60, expect_rc: 0, expect: ['^Python 3'] },
  description: 'Python 3.12',
};
const HANDLE = 'b-0123456789abcdef0123456789';
const BUILD_PATH = `/v1/templates/my-python/builds/${HANDLE}`;
const QUEUED = { templateId: 'my-python', buildId: null, build: BUILD_PATH, status: 'queued' };
const handled = (over: Record<string, unknown> = {}) =>
  build({ handle: HANDLE, reason: null, ...over });

/** Files in a temp directory: a spec, a gate record, anything a create reads. */
function files(o: Record<string, unknown>): Record<string, string> & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sbx-tpl-'));
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(o)) {
    out[name] = join(dir, name);
    writeFileSync(out[name], typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
  return { dir, ...out };
}

describe('errors keep the rule and the quota', () => {
  it('reads rule and quota from the body, and prints them', async () => {
    const res = (status: number, body: object) => new Response(JSON.stringify(body), { status });
    const p = await errorFromResponse(
      'control-plane',
      res(422, {
        error: 'policy_refused',
        message: "spec.id must be the create's id",
        rule: 'M7.spec_id',
      }),
    );
    expect(p).toMatchObject({ code: 'policy_refused', rule: 'M7.spec_id' });
    expect(refusalText(p)).toBe(
      "refused by policy rule M7.spec_id: spec.id must be the create's id",
    );
    const q = await errorFromResponse(
      'control-plane',
      res(429, {
        error: 'quota_exceeded',
        message: 'at most 10 builds queued per subject',
        quota: 'buildsQueued',
      }),
    );
    expect(refusalText(q)).toBe(
      'over your buildsQueued quota: at most 10 builds queued per subject',
    );
    const n = await errorFromResponse(
      'control-plane',
      res(404, { error: 'template_not_found', message: 'no such template', rule: 7 }),
    );
    expect(n.rule).toBeUndefined();
    expect(refusalText(n)).toBe('no such template');
    expect(new ApiError('control-plane', 0, 'network_error', 'x', 5).rule).toBeUndefined();
  });

  it('prints a policy refusal with its rule, exit 1', async () => {
    const f = files({ 'spec.json': SPEC });
    const w = world({
      'POST /v1/templates': () => ({
        status: 422,
        body: { error: 'policy_refused', message: 'needs a gate record (X10)', rule: 'X10' },
      }),
    });
    expect(await w.run(['templates', 'create', '--spec', f['spec.json']!])).toBe(1);
    expect(w.err()).toContain('sbx: refused by policy rule X10: needs a gate record (X10)');
  });
});

describe('sbx quota, policy', () => {
  it('quota: limit and use, and --json', async () => {
    const q = {
      subject: 'github:1',
      templates: { limit: 100, used: 3 },
      buildsQueued: { limit: 10, used: 1 },
      active: { limit: 8, used: 0 },
      sandboxes: { limit: 3, used: 1 },
    };
    const w = world({ 'GET /v1/quota': () => ({ status: 200, body: q }) });
    expect(await w.run(['quota'])).toBe(0);
    expect(w.out()).toBe(
      'github:1\n' +
        'templates      3 of 100\n' +
        'buildsQueued   1 of 10\n' +
        'active         0 of 8\n' +
        'sandboxes      1 of 3\n',
    );
    expect(await w.run(['quota', '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toEqual(q);
  });

  it('policy: each profile, the registries, the quotas and the digest', async () => {
    const w = world({ 'GET /v1/policy': () => ({ status: 200, body: policyView() }) });
    expect(await w.run(['policy'])).toBe(0);
    expect(w.out()).toMatch(
      /^base +\(default\) guest <= 16384 MiB, vcpus <= 8, workspace <= 16384 MiB; egress allowed; requires nothing$/m,
    );
    expect(w.out()).toMatch(
      /^benchmark +guest <= 4096 MiB.*\(exactly 4096 MiB, 2 vCPUs\); no egress; requires X1 X10 X11 X12 X14 X15$/m,
    );
    expect(w.out()).toContain('registries <default>\n');
    expect(w.out()).toContain(
      'trusted gate records 0; quota templates 100, builds queued 10, active 8\n',
    );
    expect(w.out()).toContain(`policy sha256:${'d'.repeat(64)} (record sha256:${'e'.repeat(64)})`);
    expect(await w.run(['policy', '--json'])).toBe(0);
    expect(JSON.parse(w.out()).digest).toBe(`sha256:${'d'.repeat(64)}`);
  });
});

describe('templates create, build, follow, cancel', () => {
  it('posts the spec with its own id and image, and the gate record byte for byte', async () => {
    const gate = '{ "schema": "example-builder/moca-microvm/1",\n  "gate": {"passed": true} }\n';
    const f = files({ 'spec.json': SPEC, 'gate.json': gate });
    const w = world({ 'POST /v1/templates': () => ({ status: 202, body: QUEUED }) });
    expect(
      await w.run([
        'templates',
        'create',
        '--spec',
        f['spec.json']!,
        '--profile',
        'benchmark',
        '--visibility',
        'private',
        '--gate-record',
        f['gate.json']!,
      ]),
    ).toBe(0);
    expect(w.cp.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/v1/templates',
      body: {
        id: 'my-python',
        image: IMAGE,
        spec: SPEC,
        profile: 'benchmark',
        visibility: 'private',
        gateRecord: gate,
      },
    });
    expect(w.out()).toBe(`my-python ${HANDLE} queued\n`);
    expect(await w.run(['templates', 'create', '--spec', f['spec.json']!, '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toEqual(QUEUED);
  });

  it('says when the create was answered with a build of the same inputs', async () => {
    const f = files({ 'spec.json': SPEC });
    const w = world({
      'POST /v1/templates': () => ({
        status: 200,
        body: {
          templateId: 'my-python',
          buildId: BUILD_ID,
          build: `/v1/templates/my-python/builds/${BUILD_ID}`,
          status: 'registered',
          reused: true,
        },
      }),
    });
    expect(await w.run(['templates', 'create', '--spec', f['spec.json']!])).toBe(0);
    expect(w.out()).toBe(
      `my-python ${BUILD_ID} registered (reused: the same inputs as this build)\n`,
    );
  });

  it("reads a gate record's template block as the spec, and refuses an id or image that differs (M7)", async () => {
    const f = files({ 'rec.json': { schema: 'example-builder/moca-microvm/1', template: SPEC } });
    const w = world({ 'POST /v1/templates': () => ({ status: 202, body: QUEUED }) });
    expect(await w.run(['templates', 'create', '--spec', f['rec.json']!])).toBe(0);
    expect((w.cp.calls.at(-1)!.body as { spec: unknown }).spec).toEqual(SPEC);
    const n = w.cp.calls.length;
    expect(await w.run(['templates', 'create', '--spec', f['rec.json']!, '--id', 'other'])).toBe(1);
    expect(w.err()).toContain('refused by policy rule M7.spec_id');
    expect(
      await w.run([
        'templates',
        'create',
        '--spec',
        f['rec.json']!,
        '--image',
        `team/x@sha256:${'f'.repeat(64)}`,
      ]),
    ).toBe(1);
    expect(w.err()).toContain('M7.spec_image');
    expect(w.cp.calls.length).toBe(n);
  });

  it('refuses bad usage locally, before any request', async () => {
    const { id: _id, image: _image, ...anon } = SPEC;
    const f = files({
      'spec.json': SPEC,
      'a.json': SPEC,
      'bad.json': 'not json',
      'anon.json': anon,
    });
    const w = world({});
    const usage = async (argv: string[], msg: RegExp) => {
      expect(await w.run(argv), argv.join(' ')).toBe(2);
      expect(w.err()).toMatch(msg);
    };
    await usage(['templates', 'create'], /templates create needs --spec F/);
    await usage(['templates', 'create', '--spec', f['bad.json']!], /cannot read --spec/);
    await usage(['templates', 'create', '--spec', join(f.dir, 'none.json')], /cannot read --spec/);
    await usage(['templates', 'create', '--spec', f['anon.json']!], /names no id: pass --id ID/);
    await usage(
      ['templates', 'create', '--spec', f['anon.json']!, '--id', 'my-python'],
      /names no image: pass --image REF/,
    );
    await usage(
      ['templates', 'create', '--spec', f['spec.json']!, '--gate-record', join(f.dir, 'no.json')],
      /cannot read --gate-record/,
    );
    await usage(
      ['templates', 'create', '--spec', f['spec.json']!, '--spec', f['a.json']!, '--id', 'x'],
      /--id and --image name one template/,
    );
    // A gate record goes with one spec, and is sized before it is read.
    writeFileSync(join(f.dir, 'gate.json'), '{}');
    await usage(
      [
        'templates',
        'create',
        '--spec',
        f['spec.json']!,
        '--spec',
        f['a.json']!,
        '--gate-record',
        join(f.dir, 'gate.json'),
      ],
      /--gate-record is one image's record: give one --spec with it/,
    );
    writeFileSync(join(f.dir, 'big.tar'), Buffer.alloc(1024 * 1024 + 1));
    await usage(
      ['templates', 'create', '--spec', f['spec.json']!, '--gate-record', join(f.dir, 'big.tar')],
      /big\.tar is 1048577 bytes: a gate record is at most 1 MiB/,
    );
    await usage(['templates', 'create', 'my-python', '--spec', f['spec.json']!], /takes no ID/);
    await usage(
      ['templates', 'build', 'my-python', '--spec', f['spec.json']!, '--id', 'x'],
      /--id only applies to templates create/,
    );
    await usage(
      ['templates', 'build', 'my-python', '--spec', f['spec.json']!, '--spec', f['a.json']!],
      /templates build takes one --spec/,
    );
    await usage(
      ['templates', 'build', 'my-python', '--spec', f['spec.json']!, '--visibility', 'private'],
      /--visibility only applies to templates create/,
    );
    await usage(['templates', 'build', '--spec', f['spec.json']!], /takes one template ID/);
    await usage(
      ['templates', 'show', 'my-python', '--spec', f['spec.json']!],
      /--spec only applies to templates create and build/,
    );
    await usage(['templates', 'show', 'my-python', '--dry-run'], /--dry-run only applies/);
    await usage(['templates', 'cancel', 'my-python'], /templates cancel needs --build BUILD/);
    await usage(
      ['templates', 'create', '--spec', f['spec.json']!, '--build', HANDLE],
      /--build only applies to templates show, follow, cancel/,
    );
    await usage(
      ['templates', 'follow', 'my-python', '--timeout', '0'],
      /--timeout must be a whole number/,
    );
    await usage(
      ['templates', 'show', 'my-python', '--timeout', '9'],
      /--timeout only applies to run and templates follow, create, build/,
    );
    await usage(['ls', '--timeout', '9'], /--timeout only applies to run and templates/);
    await usage(['templates', 'follow'], /templates follow takes one template ID/);
    await usage(['quota', 'x'], /too many arguments for quota/);
    expect(w.cp.calls).toEqual([]);
  });

  it('build ID: posts to /builds, with ID as the template', async () => {
    const { id: _id, ...spec } = SPEC;
    const f = files({ 'spec.json': spec });
    const w = world({
      'POST /v1/templates/my-python/builds': () => ({ status: 202, body: QUEUED }),
    });
    expect(await w.run(['templates', 'build', 'my-python', '--spec', f['spec.json']!])).toBe(0);
    expect(w.cp.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/v1/templates/my-python/builds',
      body: { id: 'my-python', image: IMAGE },
    });
    expect(w.out()).toBe(`my-python ${HANDLE} queued\n`);
  });

  it('409 template_exists on an id read as your own: the refusal as sent, no answer made up', async () => {
    const f = files({ 'spec.json': SPEC });
    const w = world({
      'POST /v1/templates': () => ({
        status: 409,
        body: { error: 'template_exists', message: "template 'my-python' exists" },
      }),
      'GET /v1/templates/my-python': () => ({
        status: 200,
        body: template({ builds: [handled({ status: 'building', readiness: null })] }),
      }),
    });
    expect(await w.run(['templates', 'create', '--spec', f['spec.json']!, '--json'])).toBe(1);
    expect(w.cp.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(w.out()).toBe('');
    expect(w.err()).toContain("template 'my-python' exists");
    expect(w.err()).not.toContain('following');
  });

  it("409 template_exists: names another's owner, and a declared one", async () => {
    const f = files({ 'spec.json': SPEC });
    let owner: string | null = 'github:1001';
    const w = world({
      'POST /v1/templates': () => ({ status: 409, body: { error: 'template_exists' } }),
      'GET /v1/templates/my-python': () => ({ status: 200, body: template({ owner }) }),
    });
    expect(await w.run(['templates', 'create', '--spec', f['spec.json']!])).toBe(1);
    expect(w.err()).toContain('my-python belongs to github:1001: pick another id');
    owner = null;
    expect(await w.run(['templates', 'create', '--spec', f['spec.json']!])).toBe(1);
    expect(w.err()).toContain('my-python is a template the deployment declared: pick another id');
  });

  it('many creates: one refused does not stop the next; a lost control plane does', async () => {
    const f = files({ 'a.json': SPEC, 'b.json': { ...SPEC, id: 'my-python-2' } });
    let down = false;
    const w = world({
      'POST /v1/templates': (req) =>
        (req.body as { id: string }).id === 'my-python'
          ? down
            ? new TypeError('fetch failed')
            : {
                status: 422,
                body: {
                  error: 'policy_refused',
                  message: 'outside the envelope',
                  rule: 'envelope',
                },
              }
          : { status: 202, body: { ...QUEUED, templateId: 'my-python-2' } },
    });
    expect(
      await w.run(['templates', 'create', '--spec', f['a.json']!, '--spec', f['b.json']!]),
    ).toBe(1);
    expect(w.err()).toContain('refused by policy rule envelope');
    expect(w.out()).toBe(`my-python-2 ${HANDLE} queued\n`);
    down = true;
    const before = w.cp.calls.length;
    expect(
      await w.run(['templates', 'create', '--spec', f['a.json']!, '--spec', f['b.json']!]),
    ).toBe(4);
    expect(w.cp.calls.slice(before).map((c) => (c.body as { id: string }).id)).not.toContain(
      'my-python-2',
    );
  });

  it('many creates: waits for a queue slot at 429 buildsQueued, then times out with exit 5', async () => {
    const f = files({ 'a.json': SPEC, 'b.json': { ...SPEC, id: 'my-python-2' } });
    let full = 2;
    const w = world({
      'POST /v1/templates': (req) =>
        (req.body as { id: string }).id === 'my-python-2' && full-- > 0
          ? {
              status: 429,
              body: { error: 'quota_exceeded', message: 'at most 1', quota: 'buildsQueued' },
              headers: { 'retry-after': '20' },
            }
          : { status: 202, body: { ...QUEUED, templateId: (req.body as { id: string }).id } },
    });
    expect(
      await w.run(['templates', 'create', '--spec', f['a.json']!, '--spec', f['b.json']!]),
    ).toBe(0);
    expect(w.out()).toBe(`my-python ${HANDLE} queued\nmy-python-2 ${HANDLE} queued\n`);
    expect(w.err()).toContain('1 waiting for a queue slot');
    expect(w.clock.slept).toEqual([20_000, 20_000]);
    full = 1000;
    expect(await w.run(['templates', 'create', '--spec', f['b.json']!, '--timeout', '60'])).toBe(5);
    expect(w.err()).toMatch(
      /timed out after 60 s waiting for a queue slot for my-python-2 \(exit 5\)/,
    );
  });

  it('many creates: Ctrl-C during the wait for a queue slot is exit 130, and posts nothing more', async () => {
    const f = files({
      'a.json': SPEC,
      'b.json': { ...SPEC, id: 'my-python-2' },
      'c.json': { ...SPEC, id: 'my-python-3' },
    });
    const w = world({
      'POST /v1/templates': () => ({
        status: 429,
        body: { error: 'quota_exceeded', message: 'at most 1', quota: 'buildsQueued' },
        headers: { 'retry-after': '20' },
      }),
    });
    const ac = new AbortController();
    const argv = ['templates', 'create', '--spec', f['a.json']!, '--spec', f['b.json']!];
    expect(
      await w.run([...argv, '--spec', f['c.json']!], {
        signal: ac.signal,
        sleep: async () => ac.abort(),
      }),
    ).toBe(130);
    expect(w.cp.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(w.err()).toContain('sbx: interrupted (exit 130)');
    expect(w.err()).not.toContain('over your buildsQueued quota');
    // Interrupted before the first POST: none is sent.
    const before = w.cp.calls.length;
    expect(await w.run(argv, { signal: ac.signal })).toBe(130);
    expect(w.cp.calls.length).toBe(before);
  });

  it('a templates quota refusal is not waited out: it fails at once', async () => {
    const f = files({ 'spec.json': SPEC });
    const w = world({
      'POST /v1/templates': () => ({
        status: 429,
        body: { error: 'quota_exceeded', message: 'at most 100 templates', quota: 'templates' },
      }),
    });
    expect(await w.run(['templates', 'create', '--spec', f['spec.json']!])).toBe(1);
    expect(w.err()).toContain('over your templates quota: at most 100 templates');
    expect(w.clock.slept).toEqual([]);
  });

  it('show: a build with its handle, and why it failed', async () => {
    const w = world({
      'GET /v1/templates/my-python': () => ({
        status: 200,
        body: template({
          builds: [
            handled({
              buildId: HANDLE,
              status: 'rejected',
              readiness: null,
              tags: [],
              reason: { message: 'the gate record is not trusted', rule: 'X1.trusted' },
            }),
            handled({ handle: 'b-1', buildId: BUILD_ID }),
          ],
        }),
      }),
    });
    expect(await w.run(['templates', 'show', 'my-python'])).toBe(0);
    expect(w.out()).toContain(
      `  ${HANDLE}  rejected  rule X1.trusted: the gate record is not trusted\n`,
    );
    expect(w.out()).toContain(`  b-1 ${BUILD_ID}  registered  inactive  tags default\n`);
  });

  it('follow: through each status and a 5xx to registered (exit 0); a cancel is 1, with its reason', async () => {
    const seq = [
      { status: 503, body: { error: 'redis_unavailable' } },
      { status: 200, body: handled({ buildId: HANDLE, status: 'queued', readiness: null }) },
      { status: 200, body: handled({ buildId: HANDLE, status: 'building', readiness: null }) },
      { status: 200, body: handled({ status: 'registered' }) },
    ];
    let i = 0;
    const w = world({
      'GET /v1/templates/my-python': () => ({
        status: 200,
        body: template({ builds: [handled({ buildId: HANDLE, status: 'queued' })] }),
      }),
      [`GET ${BUILD_PATH}`]: () => seq[Math.min(i++, seq.length - 1)]!,
    });
    expect(await w.run(['templates', 'follow', 'my-python'])).toBe(0);
    expect(w.err()).toContain(`my-python ${HANDLE}: queued`);
    expect(w.err()).toContain(`my-python ${HANDLE}: building`);
    expect(w.err()).toMatch(/polling again/);
    expect(w.out()).toBe(`my-python ${HANDLE} ${BUILD_ID}  registered  inactive  tags default\n`);
    seq.splice(0, seq.length, {
      status: 200,
      body: handled({
        buildId: HANDLE,
        status: 'failed',
        readiness: null,
        tags: [],
        reason: { message: 'cancelled by github:1', step: 'cancelled' },
      }),
    });
    i = 0;
    expect(await w.run(['templates', 'follow', 'my-python', '--build', HANDLE, '--json'])).toBe(1);
    expect(JSON.parse(w.out())).toMatchObject({ status: 'failed' });
    expect(w.err()).toContain(`${HANDLE} was cancelled: step cancelled: cancelled by github:1`);
  });

  it('follow: a 404 is a refusal, at once; past --timeout is exit 5; no build is exit 1', async () => {
    let missing = true;
    const w = world({
      [`GET ${BUILD_PATH}`]: () =>
        missing
          ? { status: 404, body: { error: 'template_not_found', message: 'no such build' } }
          : { status: 200, body: handled({ buildId: HANDLE, status: 'probing', readiness: null }) },
      'GET /v1/templates/empty': () => ({
        status: 200,
        body: template({ id: 'empty', builds: [], tags: {} }),
      }),
    });
    expect(await w.run(['templates', 'follow', 'my-python', '--build', HANDLE])).toBe(1);
    expect(w.err()).toContain('no such build');
    missing = false;
    expect(
      await w.run(['templates', 'follow', 'my-python', '--build', HANDLE, '--timeout', '12']),
    ).toBe(5);
    expect(w.clock.slept).toEqual([5000, 5000, 2000]);
    expect(w.err()).toContain('timed out after 12 s');
    expect(await w.run(['templates', 'follow', 'empty'])).toBe(1);
    expect(w.err()).toContain('empty has no build to follow');
  });

  it('follow: Ctrl-C is exit 130, not a failed build', async () => {
    const w = world({
      [`GET ${BUILD_PATH}`]: () => ({
        status: 200,
        body: handled({ buildId: HANDLE, status: 'building', readiness: null }),
      }),
    });
    const ac = new AbortController();
    expect(
      await w.run(['templates', 'follow', 'my-python', '--build', HANDLE], {
        signal: ac.signal,
        sleep: async () => ac.abort(),
      }),
    ).toBe(130);
    expect(w.err()).toContain('sbx: interrupted (exit 130)');
    expect(w.out()).toBe('');
  });

  it('cancel: posts the cancel, and reports a build past cancelling', async () => {
    let ok = true;
    const w = world({
      [`POST ${BUILD_PATH}/cancel`]: () =>
        ok
          ? { status: 200, body: { templateId: 'my-python', build: HANDLE, status: 'failed' } }
          : {
              status: 400,
              body: { error: 'invalid_request', message: 'the build is registered' },
            },
    });
    expect(await w.run(['templates', 'cancel', 'my-python', '--build', HANDLE])).toBe(0);
    expect(w.out()).toBe(`cancelled my-python ${HANDLE}\n`);
    ok = false;
    expect(await w.run(['templates', 'cancel', 'my-python', '--build', HANDLE])).toBe(1);
    expect(w.err()).toContain('the build is registered');
  });
});

describe('templates create --dry-run', () => {
  const pol = policyView().policy;
  const ok: { id: string; image: string; spec: Record<string, unknown> } = {
    id: 'my-python',
    image: IMAGE,
    spec: SPEC,
  };
  const fails = (input: Partial<typeof ok> & { profile?: string; gateRecord?: string }) =>
    dryRun({ ...ok, ...input }, pol).failed?.rule;

  it('passes a good spec, under either name for the guest memory', () => {
    expect(dryRun(ok, pol)).toMatchObject({ profile: 'base', notes: [] });
    expect(dryRun(ok, pol).failed).toBeUndefined();
    const { guest_ram_mb: _g, ...rest } = SPEC;
    expect(fails({ spec: { ...rest, guest_mb: 4096 } })).toBeUndefined();
    // A host with a port, in any case (hosts compare case-insensitively): M1 passes.
    const hosted = `Registry.Example.com:5000/team/moca-microvm@${DIGEST}`;
    const { image: _i, ...noImage } = SPEC;
    expect(fails({ image: hosted, spec: noImage })).toBeUndefined();
    expect(dryRun({ ...ok, spec: { ...SPEC, guest_mb: 4096 } }, pol).failed?.message).toBe(
      'spec takes guest_ram_mb or its alias guest_mb, not both',
    );
  });

  it('checks a gate record sent or named, and X12, under every profile', () => {
    const rec = (o: object) =>
      JSON.stringify({ gate: { passed: true }, image: { digest: DIGEST }, ...o });
    // base: a record sent is checked (passed, for this image), not trusted.
    expect(fails({ gateRecord: rec({ gate: { passed: false } }) })).toBe('X1');
    expect(fails({ gateRecord: rec({ image: { digest: 'x' } }) })).toBe('X1.image');
    expect(fails({ spec: { ...SPEC, source_record_digest: DIGEST } })).toBe('X10.record');
    // X12: an unbacked skip of the git identity check is refused under base too.
    const skip = { ...SPEC, skip_git_identity_check: true };
    expect(fails({ spec: skip })).toBe('X12');
    expect(dryRun({ ...ok, spec: skip }, pol).failed?.message).toMatch(/needs a gate record/);
    expect(fails({ spec: skip, gateRecord: rec({}) })).toBe('X12');
    expect(
      fails({
        spec: skip,
        gateRecord: rec({
          observed: { testbed: { agent_can_commit: 'no' }, guest: { git_identity: 'none' } },
        }),
      }),
    ).toBeUndefined();
  });

  it.each([
    ['M7.id', { id: 'My_Python' }],
    ['M7.id', { id: 'x'.repeat(32) }],
    ['M1', { image: 'team/moca-microvm:latest' }],
    ['M1', { image: 'team/moca-microvm@sha256:<64 hex>' }],
    // The distribution reference grammar, as the server's: no tag, lowercase path, no empty part.
    ['M1', { image: `team/moca-microvm:v1@${DIGEST}` }],
    ['M1', { image: `Team/moca-microvm@${DIGEST}` }],
    ['M1', { image: `team//moca-microvm@${DIGEST}` }],
    ['M1', { image: `-team/moca-microvm@${DIGEST}` }],
    ['M1', { image: `../moca-microvm@${DIGEST}` }],
    ['M1', { image: `bad_host.example.com/moca-microvm@${DIGEST}` }],
    ['M7.spec_id', { id: 'other' }],
    ['M7.spec_image', { image: `team/other@sha256:${'f'.repeat(64)}` }],
    ['profile', { profile: 'nope' }],
  ] as const)('refuses %s', (rule, input) => {
    expect(fails(input)).toBe(rule);
  });

  it.each([
    ['M7.guest', { guest_ram_mb: 64 }],
    ['M7.guest', { guest_mb: 4096 }],
    ['M7.vcpus', { vcpus: 0 }],
    ['M7.workspace', { workspace_mb: 100 }],
    ['M7.home', { guest_home: '/home/x' }],
    ['M7.egress', { egress: 'no' }],
    ['M7.seed', { seed: 1 }],
    ['M7.probe', { probe: { cmd: '', timeout_s: 60, expect_rc: 0 } }],
    ['M7.tools', { tools: ['bash', 'bash'] }],
    ['M7.description', { description: '' }],
    ['M7.skip_git_identity_check', { skip_git_identity_check: 'yes' }],
    ['M8', { guest_home_gitconfig: true }],
    ['M9', { probe_status: 'unmeasured' }],
    ['envelope', { guest_ram_mb: 32_768 }],
    ['X10', { source_record_digest: `sha256:${'9'.repeat(64)}` }],
  ] as const)('refuses a spec failing %s', (rule, change) => {
    expect(fails({ spec: { ...SPEC, ...change } })).toBe(rule);
  });

  it("the benchmark profile needs a passed gate record for this image; the record's trust is the server's", () => {
    const benchmark = { profile: 'benchmark' };
    const bench = {
      ...SPEC,
      probe_status: 'vm',
      source_record_digest: DIGEST,
      skip_git_identity_check: true,
    };
    expect(fails({ ...benchmark, spec: bench })).toBe('X10.record');
    const gate = (o: object) =>
      JSON.stringify({
        schema: 'example-builder/moca-microvm/1',
        gate: { passed: true },
        image: { digest: DIGEST },
        observed: { testbed: { agent_can_commit: 'no' }, guest: { git_identity: 'none' } },
        ...o,
      });
    // Not in the policy's trusted list (it is empty), yet passed: X1.trusted is the server's to check.
    const r = dryRun({ ...ok, ...benchmark, spec: bench, gateRecord: gate({}) }, pol);
    expect(r.failed).toBeUndefined();
    expect(r.results.map((x) => x.rule)).not.toContain('X1.trusted');
    expect(
      fails({ ...benchmark, spec: bench, gateRecord: gate({ gate: { passed: false } }) }),
    ).toBe('X1');
    expect(fails({ ...benchmark, spec: bench, gateRecord: gate({ image: { digest: 'x' } }) })).toBe(
      'X1.image',
    );
    expect(fails({ ...benchmark, spec: { ...bench, egress: true }, gateRecord: gate({}) })).toBe(
      'X11',
    );
    expect(
      fails({ ...benchmark, spec: { ...bench, probe_status: undefined }, gateRecord: gate({}) }),
    ).toBe('X14');
    expect(fails({ ...benchmark, spec: { ...bench, vcpus: 1 }, gateRecord: gate({}) })).toBe('X15');
    expect(
      fails({
        ...benchmark,
        spec: bench,
        gateRecord: gate({ observed: { testbed: { agent_can_commit: 'yes' } } }),
      }),
    ).toBe('X12');
    expect(fails({ ...benchmark, spec: bench, gateRecord: 'not json' })).toBe('gate.json');
    // A record sent with a profile that requires none is admitted, and said to be untrusted.
    const base = dryRun({ ...ok, gateRecord: gate({}) }, pol);
    expect(base.failed).toBeUndefined();
    expect(base.notes.join('\n')).toContain(
      'the base profile requires no gate record (X1): it is checked and stored with the build, not trusted',
    );
  });

  it('passes the onboarding examples, each under the profile it is made for', () => {
    const ex = (name: string) =>
      readFileSync(
        new URL(`../../../deploy/sbx/template-onboarding/examples/${name}`, import.meta.url),
        'utf8',
      );
    const def = JSON.parse(ex('default.json')) as Record<string, unknown>;
    expect(
      dryRun({ id: def.id as string, image: def.image as string, spec: def }, pol).failed,
    ).toBeUndefined();
    const swe = JSON.parse(ex('django__django-11133.json')) as Record<string, unknown>;
    const r = dryRun(
      {
        id: swe.id as string,
        image: swe.image as string,
        spec: swe,
        profile: 'benchmark',
        gateRecord: ex('django__django-11133.gate-record.json'),
      },
      pol,
    );
    expect(r.failed).toBeUndefined();
  });

  it('runs from the CLI: reads the policy, creates nothing, exit 1 with the rule', async () => {
    const f = files({ 'good.json': SPEC, 'bad.json': { ...SPEC, id: 'other-id', vcpus: 64 } });
    const w = world({ 'GET /v1/policy': () => ({ status: 200, body: policyView() }) });
    expect(await w.run(['templates', 'create', '--spec', f['good.json']!, '--dry-run'])).toBe(0);
    expect(w.out()).toBe('my-python: passes the local checks (base)\n');
    expect(
      await w.run([
        'templates',
        'create',
        '--spec',
        f['good.json']!,
        '--spec',
        f['bad.json']!,
        '--dry-run',
        '--json',
      ]),
    ).toBe(1);
    const lines = w
      .out()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { failed?: { rule: string } });
    expect(lines.map((l) => l.failed?.rule)).toEqual([undefined, 'M7.vcpus']);
    expect(w.err()).toContain('other-id');
    expect(w.err()).toContain('would be refused by policy rule M7.vcpus: spec.vcpus must be 1-32');
    expect(
      await w.run(['templates', 'build', 'my-python', '--spec', f['good.json']!, '--dry-run']),
    ).toBe(0);
    expect(w.cp.calls.every((c) => c.method === 'GET' && c.path === '/v1/policy')).toBe(true);
  });

  it("sanitizes the policy's text (a profile name, an envelope value) in what it prints", async () => {
    const evil = 'ev\u001b[2Jil';
    const gate = JSON.stringify({ gate: { passed: true }, image: { digest: IMAGE.split('@')[1] } });
    const f = files({ 'spec.json': SPEC, 'gate.json': gate });
    const w = world({
      'GET /v1/policy': () => ({
        status: 200,
        body: policyView({
          profiles: {
            [evil]: {
              requires: [],
              envelope: { maxGuestMb: '\u001b]0;title\u0007', maxVcpus: 8, maxWorkspaceMb: 16_384 },
            },
          },
          defaultProfile: evil,
        }),
      }),
    });
    expect(
      await w.run([
        'templates',
        'create',
        '--spec',
        f['spec.json']!,
        '--gate-record',
        f['gate.json']!,
        '--dry-run',
      ]),
    ).toBe(1);
    expect(w.err()).toContain('would be refused by policy rule envelope');
    expect(w.err()).toContain('evil profile requires no gate record');
    expect(w.err()).not.toMatch(/[\u001b\u0007]/);
  });
});

describe('retire --wait default', () => {
  it("outlasts the 600 s a host keeps shipping an ended sandbox's egress before the removal", () => {
    expect(RETIRE_TIMEOUT_S).toBeGreaterThan(600);
  });
});
