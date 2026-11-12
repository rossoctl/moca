import { afterEach, describe, expect, it } from 'vitest';
import { openSbxRuntime, sbxMain } from '../src/sbx/cli.js';
import { SBX_EXIT } from '../src/sbx/commands.js';
import { cmdActivate, cmdRetire } from '../src/sbx/templates.js';
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
// `templates activate` and `templates deactivate`; and retire (§5.1): `templates retire`.
// example.com hosts only.

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
    expect(w.io.errs.join('')).toContain(`my-python ${HANDLE}: retired, its worker stopped`);
    expect(w.io.errs.join('')).not.toContain('removed from every host');
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
