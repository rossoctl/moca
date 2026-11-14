import { beforeEach, describe, expect, it } from 'vitest';
import type { CpError } from '../src/errors.js';
import { HANDLERS, type CpDeps, type RequestCtx } from '../src/handlers.js';
import { InMemoryCredentialStore } from '../src/credential-store.js';
import { makeDeps, ctx, alice, bob, codeOf } from './helpers/deps.js';

const body = (over: Record<string, unknown> = {}) => ({
  kind: 'bearer',
  consumer: 'sandbox-egress',
  destination: { hosts: ['api.github.com'] },
  secret: { token: 'ghp-fake' }, // notsecret
  ...over,
});

describe('PUT /v1/credentials/{name}', () => {
  let d: CpDeps;
  beforeEach(() => {
    d = makeDeps();
  });

  it('stores a credential for the calling subject', async () => {
    const res = await HANDLERS.putCredential!(
      ctx({ principal: alice, params: { name: 'github-work' }, body: body() }),
      d,
    );
    expect(res.status).toBe(204);
    expect((await d.credentials.get('github:1234', 'github-work'))?.secret.token).toBe('ghp-fake'); // notsecret
  });

  it('returns no body at all, so there is no read-back path even on write', async () => {
    const res = await HANDLERS.putCredential!(
      ctx({ principal: alice, params: { name: 'github-work' }, body: body() }),
      d,
    );
    expect(res.body).toBeUndefined();
  });

  it('cannot write into another subject`s store', async () => {
    // The subject comes from the TOKEN, never from the path or the body -- the principal is never in
    // a path (spec §4.1), so there is nothing here to spoof.
    await HANDLERS.putCredential!(
      ctx({ principal: alice, params: { name: 'github-work' }, body: body() }),
      d,
    );
    expect(await d.credentials.get('github:9999', 'github-work')).toBeNull();
  });

  it('ignores a subject or owner field smuggled into the body', async () => {
    await HANDLERS.putCredential!(
      ctx({
        principal: alice,
        params: { name: 'github-work' },
        body: body({ subject: 'github:9999', owner: 'github:9999' }),
      }),
      d,
    );
    expect(await d.credentials.get('github:9999', 'github-work')).toBeNull();
    expect(await d.credentials.get('github:1234', 'github-work')).not.toBeNull();
  });

  it('rejects an invalid name and an invalid descriptor with invalid_request', async () => {
    expect(
      await codeOf(() =>
        HANDLERS.putCredential!(
          ctx({ principal: alice, params: { name: 'Bad Name' }, body: body() }),
          d,
        ),
      ),
    ).toBe('invalid_request');
    expect(
      await codeOf(() =>
        HANDLERS.putCredential!(
          ctx({ principal: alice, params: { name: 'ok' }, body: body({ kind: 'telepathy' }) }),
          d,
        ),
      ),
    ).toBe('invalid_request');
  });

  it('overwrites on re-put, which is how a user rotates a key', async () => {
    const put = (token: string) =>
      HANDLERS.putCredential!(
        ctx({ principal: alice, params: { name: 'k' }, body: body({ secret: { token } }) }),
        d,
      );
    await put('ghp-old'); // notsecret
    await put('ghp-new'); // notsecret
    expect((await d.credentials.get('github:1234', 'k'))?.secret.token).toBe('ghp-new'); // notsecret
    expect(await d.credentials.list('github:1234')).toHaveLength(1);
  });

  it('audits the write by NAME, never by value', async () => {
    const deps = makeDeps({ withStreams: true });
    const streams = deps.streams;
    await HANDLERS.putCredential!(
      ctx({ principal: alice, params: { name: 'github-work' }, body: body() }),
      deps,
    );
    const rows = streams.get('sh:cp:audit') ?? [];
    expect(
      rows.some((r) => r.decision === 'credential_written' && r.credential === 'github-work'),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('ghp-fake'); // notsecret
  });

  it('needs a token', async () => {
    expect(
      await codeOf(() => HANDLERS.putCredential!(ctx({ params: { name: 'k' }, body: body() }), d)),
    ).toBe('token_required');
  });
});

describe('GET /v1/credentials', () => {
  let d: CpDeps;
  beforeEach(async () => {
    d = makeDeps();
    await HANDLERS.putCredential!(
      ctx({ principal: alice, params: { name: 'github-work' }, body: body() }),
      d,
    );
    await HANDLERS.putCredential!(
      ctx({
        principal: alice,
        params: { name: 'my-anthropic' },
        body: body({ consumer: 'inference', endpoint: 'https://litellm.internal/v1' }),
      }),
      d,
    );
  });

  it('returns metadata only — NO value is ever returned', async () => {
    const res = await HANDLERS.listCredentials!(ctx({ principal: alice }), d);
    const creds = (res.body as { credentials: Record<string, unknown>[] }).credentials;
    const json = JSON.stringify(res.body);
    // The stored value must not appear, and no `secret` field may exist.
    expect(json).not.toContain('ghp-fake'); // notsecret
    for (const cred of creds) expect(Object.keys(cred)).not.toContain('secret');
    // Pin the shape exactly, which is stricter than banning substrings: any field added later has
    // to be added here deliberately. NOTE `binding` IS returned and IS correct -- spec §6.2 lists
    // `kind`, `consumer`, `destination` and `binding` as explicitly NOT secret, and the OpenAPI
    // contract makes `binding` required on CredentialDescriptor. Its `format` legitimately contains
    // the literal template placeholder `{token}`, which is why a blunt `not.toContain('token')`
    // assertion would be wrong here: it would fail on correct output and pressure an implementer
    // into stripping a documented field to make the test pass.
    for (const cred of creds) {
      expect(Object.keys(cred).sort()).toEqual([
        'binding',
        'consumer',
        'destination',
        'endpoint',
        'kind',
        'name',
      ]);
    }
  });

  it('returns the fields a user needs to tell two credentials apart', async () => {
    const res = await HANDLERS.listCredentials!(ctx({ principal: alice }), d);
    const creds = (res.body as { credentials: Record<string, unknown>[] }).credentials;
    expect(creds.map((c) => c.name).sort()).toEqual(['github-work', 'my-anthropic']);
    const inference = creds.find((c) => c.name === 'my-anthropic')!;
    expect(inference).toMatchObject({
      kind: 'bearer',
      consumer: 'inference',
      endpoint: 'https://litellm.internal/v1',
    });
    expect(inference.destination).toEqual({ hosts: ['api.github.com'] });
  });

  it("shows nothing of another subject's store", async () => {
    expect((await HANDLERS.listCredentials!(ctx({ principal: bob }), d)).body).toEqual({
      credentials: [],
    });
  });

  it('takes no ?owner= — there is deliberately no admin path to a user`s credential list', async () => {
    // Listing another user's credential NAMES is not a privilege MU1 grants; the query parameter
    // simply is not read, so it cannot become one by accident.
    const res = await HANDLERS.listCredentials!(
      ctx({ principal: bob, query: new URLSearchParams('owner=github:1234') }),
      d,
    );
    expect(res.body).toEqual({ credentials: [] });
  });
});

describe('DELETE /v1/credentials/{name}', () => {
  it('deletes the caller`s credential and is idempotent', async () => {
    const d = makeDeps();
    await HANDLERS.putCredential!(
      ctx({ principal: alice, params: { name: 'k' }, body: body() }),
      d,
    );
    expect(
      (await HANDLERS.deleteCredential!(ctx({ principal: alice, params: { name: 'k' } }), d))
        .status,
    ).toBe(204);
    expect(await d.credentials.get('github:1234', 'k')).toBeNull();
    // A second delete is 204 too: 404 here would be an existence oracle over credential names.
    expect(
      (await HANDLERS.deleteCredential!(ctx({ principal: alice, params: { name: 'k' } }), d))
        .status,
    ).toBe(204);
  });

  it("cannot delete another subject's credential", async () => {
    const d = makeDeps();
    await HANDLERS.putCredential!(
      ctx({ principal: alice, params: { name: 'k' }, body: body() }),
      d,
    );
    await HANDLERS.deleteCredential!(ctx({ principal: bob, params: { name: 'k' } }), d);
    expect(await d.credentials.get('github:1234', 'k')).not.toBeNull();
  });

  it('rejects an invalid name rather than passing it to the store', async () => {
    expect(
      await codeOf(() =>
        HANDLERS.deleteCredential!(
          ctx({ principal: alice, params: { name: '../escape' } }),
          makeDeps(),
        ),
      ),
    ).toBe('invalid_request');
  });
});

describe('sandbox profile', () => {
  const egressDeps = (): CpDeps => {
    const base = makeDeps().config.sandbox!;
    return makeDeps({
      credentials: new InMemoryCredentialStore(),
      config: {
        routeProfile: 'sandbox',
        sandbox: {
          ...base,
          egress: {
            hosts: [{ id: 'kvm', workers: ['sbx_default'], token: 'a'.repeat(64) }], // notsecret
            ttlSeconds: 60,
          },
        },
      },
    });
  };
  const outsider = {
    sub: 'github:5555',
    tenant: 'github:5555',
    roles: [],
    scope: ['api'],
  } as unknown as typeof alice;

  it('refuses a non-sandbox-egress consumer', async () =>
    expect(
      await codeOf(() =>
        HANDLERS.putCredential!(
          ctx({ principal: alice, params: { name: 'gh' }, body: body({ consumer: 'inference' }) }),
          egressDeps(),
        ),
      ),
    ).toBe('invalid_request'));

  it('refuses an unenrolled subject on all three routes', async () => {
    for (const op of ['putCredential', 'listCredentials', 'deleteCredential'])
      expect(
        await codeOf(() =>
          HANDLERS[op]!(
            ctx({ principal: outsider, params: { name: 'gh' }, body: body() }),
            egressDeps(),
          ),
        ),
      ).toBe('not_enrolled');
  });

  it('stores and lists only sandbox-egress credentials', async () => {
    const d = egressDeps();
    await HANDLERS.putCredential!(
      ctx({ principal: alice, params: { name: 'gh' }, body: body() }),
      d,
    );
    const stored = (await d.credentials.get('github:1234', 'gh'))!;
    await d.credentials.put('github:1234', {
      ...stored,
      descriptor: { ...stored.descriptor, name: 'inf', consumer: 'inference' },
    });
    const r = await HANDLERS.listCredentials!(ctx({ principal: alice }), d);
    expect((r.body as { credentials: { name: string }[] }).credentials.map((c) => c.name)).toEqual([
      'gh',
    ]);
  });

  describe('destination conflicts', () => {
    const put = (d: CpDeps, name: string, hosts: string[]) =>
      HANDLERS.putCredential!(
        ctx({ principal: alice, params: { name }, body: body({ destination: { hosts } }) }),
        d,
      );

    it('refuses an identical normalized destination under another name, naming the holder', async () => {
      const d = egressDeps();
      await put(d, 'gh', ['github.com']);
      let err: CpError | undefined;
      try {
        await put(d, 'gh2', ['GitHub.com']);
      } catch (e) {
        err = e as CpError;
      }
      expect(err?.code).toBe('destination_conflict');
      expect(err?.message).toContain('gh');
      expect(await d.credentials.get('github:1234', 'gh2')).toBeNull();
    });

    it('refuses it on combined too, where the credential routes keep the harness behaviour', async () => {
      const d = egressDeps();
      d.config.routeProfile = 'combined';
      await put(d, 'gh', ['github.com']);
      expect(await codeOf(() => put(d, 'gh2', ['GitHub.com']))).toBe('destination_conflict');
      // An inference credential is not an egress one: no conflict check.
      const inf = await HANDLERS.putCredential!(
        ctx({
          principal: alice,
          params: { name: 'inf' },
          body: body({ consumer: 'inference', destination: { hosts: ['github.com'] } }),
        }),
        d,
      );
      expect(inf.status).toBe(204);
    });

    it('allows sibling and nested prefixes', async () => {
      const d = egressDeps();
      await put(d, 'mcp-a', ['mcp.corp/github']);
      await put(d, 'mcp-b', ['mcp.corp/jira']);
      await put(d, 'mcp-root', ['mcp.corp']);
      expect((await d.credentials.list('github:1234')).length).toBe(3);
    });

    it('allows re-PUT of the same name', async () => {
      const d = egressDeps();
      await put(d, 'gh', ['github.com']);
      const res = await put(d, 'gh', ['github.com']);
      expect(res.status).toBe(204);
    });

    it('stores a multi-header binding and lists it as an array', async () => {
      const d = egressDeps();
      await HANDLERS.putCredential!(
        ctx({
          principal: alice,
          params: { name: 'multi' },
          body: body({
            kind: 'api-key',
            secret: { key: 'k' }, // notsecret
            binding: [
              { header: 'X-API-Key', format: '{key}' },
              { header: 'X-Org', format: 'acme-{key}' },
            ],
          }),
        }),
        d,
      );
      const r = await HANDLERS.listCredentials!(ctx({ principal: alice }), d);
      const list = (r.body as { credentials: { binding: unknown }[] }).credentials;
      expect(Array.isArray(list[0]!.binding)).toBe(true);
    });
  });
});
