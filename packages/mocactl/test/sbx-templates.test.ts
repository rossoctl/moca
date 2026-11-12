import { afterEach, describe, expect, it } from 'vitest';
import { openSbxRuntime, sbxMain } from '../src/sbx/cli.js';
import { SBX_EXIT } from '../src/sbx/commands.js';
import { cmdActivate } from '../src/sbx/templates.js';
import {
  cleanupTmp,
  fakeCp,
  sandbox,
  SBX,
  setup,
  TOKEN,
  URL_,
  workspaces,
  type Handler,
} from './helpers/sbx.js';

// The template reads from mocactl (template lifecycle spec §4): `sbx templates` with readiness and
// tags, `templates show`, and `create --template ID[@BUILD] --seed`; and activation (§6.3):
// `templates activate` and `templates deactivate`; and the hosts' slots and memory (§6.2):
// `sbx hosts`, and why an unavailable build waits. example.com hosts only.

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

function world(routes: Record<string, Handler>) {
  const s = setup();
  const cp = fakeCp(routes);
  const run = (argv: string[], over: Record<string, unknown> = {}) => {
    s.io.outs.length = 0;
    s.io.errs.length = 0;
    return sbxMain(argv, s.env, s.io, { home: s.home, fetchImpl: cp.fetchImpl, ...over });
  };
  return {
    ...s,
    cp,
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
