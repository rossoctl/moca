import { describe, expect, it } from 'vitest';
import { openSbx, sbxMain } from '../src/sbx/cli.js';
import {
  addCredential,
  expandPreset,
  NOT_OFFERED,
  presetById,
  type Preset,
} from '../src/sbx/credentials.js';
import { fakeCp, setup, type Handler } from './helpers/sbx.js';

const PAT = 'ghp_x';
const ok: Handler = () => ({ status: 204 });

function run(
  argv: string[],
  routes: Record<string, Handler>,
  o: { stdin?: string; tty?: boolean } = {},
) {
  const s = setup();
  const cp = fakeCp(routes);
  let stdinReads = 0;
  const code = sbxMain(argv, s.env, s.io, {
    home: s.home,
    fetchImpl: cp.fetchImpl,
    stdinIsTTY: o.tty === true,
    readStdin: async () => (stdinReads++, o.stdin ?? ''),
  });
  return {
    code,
    cp,
    s,
    reads: () => stdinReads,
    text: () => [...s.io.outs, ...s.io.errs].join('\n'),
  };
}

describe('mocactl sbx credentials add --preset', () => {
  it('stores github as one basic credential on both hosts, and never prints the PAT', async () => {
    const r = run(
      ['credentials', 'add', 'github', '--preset', 'github'],
      { 'PUT /v1/credentials/github': ok },
      { stdin: `${PAT}\n` },
    );
    expect(await r.code).toBe(0);
    expect(r.cp.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PUT /v1/credentials/github']);
    expect(r.cp.calls[0]!.body).toEqual({
      kind: 'basic',
      consumer: 'sandbox-egress',
      destination: { hosts: ['github.com', 'api.github.com'] },
      secret: { username: 'x-access-token', password: PAT },
    });
    const text = r.text();
    expect(text).toContain('stored credential github for github.com, api.github.com');
    expect(text).toContain('fine-grained PAT');
    expect(text).not.toContain(PAT);
  });

  it('stores github-mcp as a bearer credential', async () => {
    const r = run(
      ['credentials', 'add', 'ghmcp', '--preset', 'github-mcp'],
      { 'PUT /v1/credentials/ghmcp': ok },
      { stdin: PAT },
    );
    expect(await r.code).toBe(0);
    expect(r.cp.calls[0]!.body).toMatchObject({
      kind: 'bearer',
      consumer: 'sandbox-egress',
      destination: { hosts: ['api.githubcopilot.com'] },
      secret: { token: PAT },
    });
    expect(r.text()).not.toContain(PAT);
  });

  it('is a usage error with --host or --kind, and an unknown id lists the known ones', async () => {
    let r = run(
      ['credentials', 'add', 'g', '--preset', 'github', '--host', 'x.example'],
      {},
      { stdin: PAT },
    );
    expect(await r.code).toBe(2);
    expect(r.reads()).toBe(0);
    expect(r.cp.calls).toEqual([]);
    r = run(
      ['credentials', 'add', 'g', '--preset', 'github', '--kind', 'bearer'],
      {},
      { stdin: PAT },
    );
    expect(await r.code).toBe(2);
    r = run(['credentials', 'add', 'g', '--preset', 'nope'], {}, { stdin: PAT });
    expect(await r.code).toBe(2);
    expect(r.text()).toContain('github');
    expect(r.text()).toContain('github-mcp');
    expect(r.reads()).toBe(0);
  });

  it('rejects a preset whose derived names would not fit, before reading stdin', async () => {
    const s = setup();
    const cp = fakeCp({});
    const opened = await openSbx({}, s.env, s.io, { home: s.home, fetchImpl: cp.fetchImpl });
    if (typeof opened === 'number') throw new Error('not logged in');
    let reads = 0;
    const two: Preset = {
      id: 'two',
      description: 'd',
      hint: 'h',
      credentials: [
        { suffix: '', kind: 'bearer', destinations: ['a.example'], fixed: {}, stdinField: 'token' },
        {
          suffix: 'api',
          kind: 'bearer',
          destinations: ['b.example'],
          fixed: {},
          stdinField: 'token',
        },
      ],
    };
    const code = await addCredential(
      { ...opened, io: s.io, json: false },
      {
        name: 'x'.repeat(38),
        preset: 'two',
        hosts: [],
        readStdin: async () => (reads++, PAT),
        stdinIsTTY: false,
      },
      [two],
    );
    expect(code).toBe(2);
    expect(reads).toBe(0);
  });
});

describe('expandPreset', () => {
  const two: Preset = {
    id: 'two',
    description: 'd',
    hint: 'the hint',
    credentials: [
      {
        suffix: '',
        kind: 'basic',
        destinations: ['a.example'],
        fixed: { username: 'u' },
        stdinField: 'password',
      },
      {
        suffix: 'api',
        kind: 'basic',
        destinations: ['api.a.example'],
        binding: { header: 'Authorization', format: 'Bearer {password}' },
        fixed: { username: 'u' },
        stdinField: 'password',
      },
    ],
  };

  it('throws a programming error, without the secret, when a preset mixes stdin fields', () => {
    const mixed: Preset = {
      ...two,
      credentials: [two.credentials[0]!, { ...two.credentials[1]!, stdinField: 'token' }],
    };
    expect(() => expandPreset(mixed, 'work', 's3cret')).toThrow(/mixes stdin fields/);
    expect(() => expandPreset(mixed, 'work', 's3cret')).not.toThrow(/s3cret/);
  });

  it('names the credentials NAME and NAME-suffix, and carries the binding', () => {
    const out = expandPreset(two, 'work', 's3cret');
    expect(out.map((e) => e.name)).toEqual(['work', 'work-api']);
    expect(out[0]!.req).toEqual({
      kind: 'basic',
      consumer: 'sandbox-egress',
      destination: { hosts: ['a.example'] },
      secret: { username: 'u', password: 's3cret' },
    });
    expect(out[1]!.req.binding).toEqual({ header: 'Authorization', format: 'Bearer {password}' });
  });

  it('finds a preset by id in the given catalog', () => {
    expect(presetById('github')?.id).toBe('github');
    expect(presetById('nope')).toBeUndefined();
    expect(presetById('two', [two])).toBe(two);
  });

  it('writes both credentials in order, and a failure on the second reports the first as stored', async () => {
    const s = setup();
    const cp = fakeCp({
      'PUT /v1/credentials/work': ok,
      'PUT /v1/credentials/work-api': () => ({
        status: 400,
        body: { error: 'invalid_request', message: 'store down' },
      }),
    });
    const opened = await openSbx({}, s.env, s.io, { home: s.home, fetchImpl: cp.fetchImpl });
    if (typeof opened === 'number') throw new Error('not logged in');
    const code = await addCredential(
      { ...opened, io: s.io, json: false },
      { name: 'work', preset: 'two', hosts: [], readStdin: async () => PAT, stdinIsTTY: false },
      [two],
    );
    expect(code).toBe(1);
    expect(cp.calls.map((c) => c.path)).toEqual([
      '/v1/credentials/work',
      '/v1/credentials/work-api',
    ]);
    const text = [...s.io.outs, ...s.io.errs].join('\n');
    expect(text).toContain('stored credential work for a.example');
    expect(text).toContain('work-api');
    expect(text).toContain('store down');
    expect(text).toContain('re-run');
    expect(text).not.toContain(PAT);
  });
});

describe('mocactl sbx credentials add --host', () => {
  it('sends a host with a path prefix through unchanged, as sandbox-egress', async () => {
    const r = run(
      [
        'credentials',
        'add',
        'corp',
        '--host',
        'mcp.corp.example/github',
        '--host',
        'b.example:8443',
      ],
      { 'PUT /v1/credentials/corp': ok },
      { stdin: 'tok\n' },
    );
    expect(await r.code).toBe(0);
    expect(r.cp.calls[0]!.body).toEqual({
      kind: 'bearer',
      consumer: 'sandbox-egress',
      destination: { hosts: ['mcp.corp.example/github', 'b.example:8443'] },
      secret: { token: 'tok' },
    });
    expect(r.text()).toContain(
      'stored credential corp for mcp.corp.example/github, b.example:8443',
    );
  });

  it('splits a comma-separated --host and trims each entry, across repeated flags', async () => {
    const r = run(
      [
        'credentials',
        'add',
        'corp',
        '--host',
        'a.example, b.example:8443/x,',
        '--host',
        'c.example',
      ],
      { 'PUT /v1/credentials/corp': ok },
      { stdin: 'tok' },
    );
    expect(await r.code).toBe(0);
    expect(r.cp.calls[0]!.body).toMatchObject({
      destination: { hosts: ['a.example', 'b.example:8443/x', 'c.example'] },
    });
  });

  it('reads a non-preset basic credential as field=value lines, and never prints the password', async () => {
    const r = run(
      ['credentials', 'add', 'corp', '--host', 'a.example', '--kind', 'basic'],
      { 'PUT /v1/credentials/corp': ok },
      { stdin: 'username=svc\npassword=pw-fixture=with=equals\n' },
    );
    expect(await r.code).toBe(0);
    expect(r.cp.calls[0]!.body).toEqual({
      kind: 'basic',
      consumer: 'sandbox-egress',
      destination: { hosts: ['a.example'] },
      secret: { username: 'svc', password: 'pw-fixture=with=equals' },
    });
    expect(r.text()).not.toContain('pw-fixture');
    // A missing field is a usage error naming it, before any request.
    const bad = run(
      ['credentials', 'add', 'corp', '--host', 'a.example', '--kind', 'basic'],
      {},
      { stdin: 'username=svc\n' },
    );
    expect(await bad.code).toBe(2);
    expect(bad.text()).toContain('stdin is missing password=…');
    expect(bad.cp.calls).toEqual([]);
  });

  it('prints one JSON object on stdout with --json: each credential, its hosts and status', async () => {
    const r = run(
      ['credentials', 'add', 'github', '--preset', 'github-mcp', '--json'],
      { 'PUT /v1/credentials/github': ok },
      { stdin: PAT },
    );
    expect(await r.code).toBe(0);
    // stdout is the JSON alone (the progress lines go to stderr), so it parses whole.
    const j = JSON.parse(r.s.io.outs.join('')) as unknown;
    expect(j).toEqual({
      credentials: [{ name: 'github', hosts: ['api.githubcopilot.com'], status: 'stored' }],
    });
    expect(r.s.io.outs.join('')).not.toContain(PAT);
  });

  it('needs a host or a preset, and a piped secret', async () => {
    let r = run(['credentials', 'add', 'corp'], {}, { stdin: 'tok' });
    expect(await r.code).toBe(2);
    r = run(['credentials', 'add', 'corp', '--host', 'a.example'], {}, { tty: true });
    expect(await r.code).toBe(2);
    expect(r.reads()).toBe(0);
    expect(r.cp.calls).toEqual([]);
  });

  it('refuses --host outside credentials add', async () => {
    const r = run(['ls', '--host', 'a.example'], {});
    expect(await r.code).toBe(2);
  });
});

describe('mocactl sbx credentials presets', () => {
  it('lists the ids with description and destinations, reading no stdin and making no request', async () => {
    const r = run(['credentials', 'presets'], {}, { stdin: 'x' });
    expect(await r.code).toBe(0);
    expect(r.reads()).toBe(0);
    expect(r.cp.calls).toEqual([]);
    const out = r.s.io.outs.join('');
    expect(out).toContain('github');
    expect(out).toContain('github-mcp');
    expect(out).toContain('api.github.com');
  });

  it('prints JSON with --json', async () => {
    const r = run(['credentials', 'presets', '--json'], {});
    expect(await r.code).toBe(0);
    const j = JSON.parse(r.s.io.outs.join('')) as {
      presets: { id: string; destinations: string[] }[];
    };
    expect(j.presets.map((p) => p.id)).toEqual(['github', 'github-mcp']);
    expect(j.presets[0]!.destinations).toEqual(['github.com', 'api.github.com']);
  });
});

describe('mocactl sbx credentials list and delete', () => {
  const listed = {
    credentials: [
      {
        name: 'github',
        kind: 'basic',
        consumer: 'sandbox-egress',
        destination: { hosts: ['github.com', 'api.github.com'] },
        binding: [{ header: 'Authorization', format: 'Basic {username}:{password}' }],
      },
    ],
  };

  it('lists names and destinations, never a secret', async () => {
    const r = run(['credentials', 'ls'], {
      'GET /v1/credentials': () => ({
        status: 200,
        body: { credentials: [{ ...listed.credentials[0], secret: { password: PAT } }] },
      }),
    });
    expect(await r.code).toBe(0);
    const out = r.s.io.outs.join('');
    expect(out).toContain('github');
    expect(out).toContain('github.com,api.github.com');
    expect(out).not.toContain(PAT);
  });

  it('lists with `credentials list` as with `ls`; both refuse extra arguments', async () => {
    const r = run(['credentials', 'list'], {
      'GET /v1/credentials': () => ({ status: 200, body: listed }),
    });
    expect(await r.code).toBe(0);
    expect(r.s.io.outs.join('')).toContain('github.com,api.github.com');
    for (const sub of ['ls', 'list']) {
      const bad = run(['credentials', sub, 'extra'], {});
      expect(await bad.code).toBe(2);
      expect(bad.cp.calls).toEqual([]);
    }
  });

  it('bare credentials points at credentials ls and prints its subcommands, with no request', async () => {
    for (const argv of [['credentials'], ['credentials', '--json']]) {
      const r = run(argv, {});
      expect(await r.code).toBe(2);
      const err = r.s.io.errs.join('');
      expect(err).toMatch(
        /^sbx: credentials needs a subcommand; to list the credentials, use 'mocactl sbx credentials ls'\nusage:\n/,
      );
      expect(err).toContain('mocactl sbx credentials add NAME');
      expect(err).not.toContain('mocactl sbx templates');
      expect(r.s.io.outs.join('')).toBe('');
      expect(r.cp.calls).toEqual([]);
    }
  });

  it('deletes a credential it lists', async () => {
    const r = run(['credentials', 'delete', 'github'], {
      'GET /v1/credentials': () => ({ status: 200, body: listed }),
      'DELETE /v1/credentials/github': ok,
    });
    expect(await r.code).toBe(0);
    expect(r.cp.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/credentials',
      'DELETE /v1/credentials/github',
    ]);
  });

  it('needs only the sandbox login, not a harness', async () => {
    const s = setup({ loggedIn: false });
    const cp = fakeCp({});
    const code = await sbxMain(['credentials', 'ls'], s.env, s.io, {
      home: s.home,
      fetchImpl: cp.fetchImpl,
    });
    expect(code).toBe(3);
  });
});

describe('mocactl sbx credentials, errors', () => {
  it('reports an unmounted route (404 not_found) as not offered, exit 2, on every route', async () => {
    for (const [argv, stdin] of [
      [['credentials', 'ls'], ''],
      [['credentials', 'delete', 'g'], ''],
      [['credentials', 'add', 'g', '--preset', 'github'], PAT],
    ] as const) {
      const r = run([...argv], {}, { stdin });
      expect(await r.code).toBe(2);
      expect(r.s.io.errs.join('\n')).toContain(NOT_OFFERED);
    }
  });

  it("prints the server's message for a 409 destination_conflict, exit 2", async () => {
    const msg = "destination 'github.com' is already held by credential 'other'";
    const r = run(
      ['credentials', 'add', 'g', '--preset', 'github'],
      {
        'PUT /v1/credentials/g': () => ({
          status: 409,
          body: { error: 'destination_conflict', message: msg },
        }),
      },
      { stdin: PAT },
    );
    expect(await r.code).toBe(2);
    expect(r.s.io.errs.join('\n')).toContain(msg);
    expect(r.text()).not.toContain(PAT);
  });

  it('reports not_enrolled as the other sbx commands do', async () => {
    const r = run(
      ['credentials', 'add', 'g', '--preset', 'github'],
      {
        'PUT /v1/credentials/g': () => ({
          status: 403,
          body: { error: 'not_enrolled', message: 'github:1 is not enrolled' },
        }),
      },
      { stdin: PAT },
    );
    expect(await r.code).toBe(1);
    expect(r.s.io.errs.join('\n')).toContain('ask an operator');
  });
});
