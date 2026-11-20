import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { subjectHash } from '../src/subject-document.js';
import { VaultCredentialStore, vaultTokenSource, type VaultFetch } from '../src/vault-store.js';
import { ALICE, BOB, cred, newKek, storeContract } from './helpers/store-contract.js';

const TOKEN = 'hvs.fake-token'; // notsecret

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * A KV v2 stand-in honouring exactly what the store relies on: GET `<mount>/data/<path>` (404 when
 * absent), POST with `options.cas` checked against the current version (Vault's 400 and its
 * "check-and-set parameter did not match" text on a mismatch), and the X-Vault-Token header. It
 * refuses any other verb -- in particular LIST -- so a store that started enumerating would fail here.
 *
 * `beforeWrite` runs between a store's read and its write, which is how a test stages a concurrent
 * writer winning the race.
 */
function fakeVault(opts: { mount?: string } = {}) {
  const mount = opts.mount ?? 'secret';
  const kv = new Map<string, { version: number; data: unknown }>();
  const calls: Call[] = [];
  const hooks: { beforeWrite?: () => void } = {};
  const reply = (status: number, body?: unknown) => ({
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });
  const fetch: VaultFetch = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, body: init.body });
    if (init.headers['X-Vault-Token'] !== TOKEN)
      return reply(403, { errors: ['permission denied'] });
    const u = new URL(url);
    const prefix = `/v1/${mount}/data/`;
    if (!u.pathname.startsWith(prefix)) return reply(404, { errors: [] });
    const path = u.pathname.slice(prefix.length);
    if (init.method === 'GET') {
      const cur = kv.get(path);
      if (!cur) return reply(404, { errors: [] });
      // Vault's answer for a soft-deleted latest version: 404, but WITH the metadata.
      if (cur.data === null) {
        return reply(404, { data: { data: null, metadata: { version: cur.version } } });
      }
      return reply(200, { data: { data: cur.data, metadata: { version: cur.version } } });
    }
    if (init.method === 'POST') {
      hooks.beforeWrite?.();
      const body = JSON.parse(init.body ?? '{}');
      const cur = kv.get(path);
      const curVersion = cur?.version ?? 0;
      if (body.options?.cas !== undefined && body.options.cas !== curVersion) {
        return reply(400, {
          errors: ['check-and-set parameter did not match the current version'],
        });
      }
      kv.set(path, { version: curVersion + 1, data: body.data });
      return reply(200, { data: { version: curVersion + 1 } });
    }
    return reply(405, { errors: ['unsupported'] });
  };
  return { fetch, kv, calls, hooks };
}

const makeStore = (
  v: ReturnType<typeof fakeVault>,
  keks: Buffer[],
  over: Partial<ConstructorParameters<typeof VaultCredentialStore>[0]> = {},
) =>
  new VaultCredentialStore({
    addr: 'https://vault.test:8200',
    token: () => TOKEN,
    mount: 'secret',
    prefix: 'moca/credentials',
    keks,
    fetch: v.fetch,
    ...over,
  });

storeContract('VaultCredentialStore', () => {
  const v = fakeVault();
  return {
    storeWith: (keks) => makeStore(v, keks),
    raw: () => JSON.stringify([...v.kv.entries()]),
    plant: (subject, edit) => {
      const path = `moca/credentials/${subjectHash(subject)}`;
      const cur = v.kv.get(path)!;
      v.kv.set(path, { version: cur.version + 1, data: edit(cur.data as Record<string, any>) });
    },
  };
});

describe('VaultCredentialStore', () => {
  it('addresses one KV v2 path per subject, by hash, and never lists', async () => {
    const v = fakeVault();
    const store = makeStore(v, [newKek()]);
    await store.put(ALICE, cred('github-work'));
    await store.list(ALICE);
    await store.get(ALICE, 'github-work');
    await store.delete(ALICE, 'github-work');
    const want = `https://vault.test:8200/v1/secret/data/moca/credentials/${subjectHash(ALICE)}`;
    expect(new Set(v.calls.map((c) => c.url))).toEqual(new Set([want]));
    expect(new Set(v.calls.map((c) => c.method))).toEqual(new Set(['GET', 'POST']));
  });

  it('writes under check-and-set: cas 0 for a new subject, then the version it read', async () => {
    const v = fakeVault();
    const store = makeStore(v, [newKek()]);
    await store.put(ALICE, cred('one'));
    await store.put(ALICE, cred('two'));
    const cas = v.calls
      .filter((c) => c.method === 'POST')
      .map((c) => JSON.parse(c.body!).options.cas);
    expect(cas).toEqual([0, 1]);
  });

  it('a lost check-and-set race re-reads and keeps BOTH writes', async () => {
    const v = fakeVault();
    const store = makeStore(v, [newKek()]);
    await store.put(ALICE, cred('mine'));
    let raced = false;
    v.hooks.beforeWrite = () => {
      if (raced) return;
      raced = true;
      // Another control-plane replica writes between our read and our write.
      const path = `moca/credentials/${subjectHash(ALICE)}`;
      const cur = v.kv.get(path)!;
      v.kv.set(path, { version: cur.version + 1, data: cur.data });
    };
    await store.put(ALICE, cred('theirs'));
    expect((await store.list(ALICE)).map((d) => d.name)).toEqual(['mine', 'theirs']);
  });

  it('gives up with credential_unavailable after repeated lost races, rather than looping', async () => {
    const v = fakeVault();
    const store = makeStore(v, [newKek()]);
    await store.put(ALICE, cred('mine'));
    v.hooks.beforeWrite = () => {
      const path = `moca/credentials/${subjectHash(ALICE)}`;
      const cur = v.kv.get(path)!;
      v.kv.set(path, { version: cur.version + 1, data: cur.data });
    };
    await expect(store.put(ALICE, cred('theirs'))).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
  });

  it('sends the token, and the namespace only when one is configured', async () => {
    const v = fakeVault();
    await makeStore(v, [newKek()]).list(ALICE);
    expect(v.calls[0]!.headers).toMatchObject({ 'X-Vault-Token': TOKEN });
    expect(v.calls[0]!.headers['X-Vault-Namespace']).toBeUndefined();
    await makeStore(v, [newKek()], { namespace: 'team-a' }).list(ALICE);
    expect(v.calls[1]!.headers['X-Vault-Namespace']).toBe('team-a');
  });

  it('honours a custom mount, a custom prefix, and a sub-path on VAULT_ADDR', async () => {
    const v = fakeVault({ mount: 'kv' });
    const store = makeStore(v, [newKek()], {
      addr: 'https://proxy.test/vault/',
      mount: '/kv/',
      prefix: '/moca/prod/',
    });
    await store.list(ALICE);
    expect(v.calls[0]!.url).toBe(
      `https://proxy.test/vault/v1/kv/data/moca/prod/${subjectHash(ALICE)}`,
    );
  });

  it('maps every Vault or transport failure to credential_unavailable, never echoing the body', async () => {
    const denied = makeStore(fakeVault(), [newKek()], { token: () => 'wrong' });
    await expect(denied.list(ALICE)).rejects.toMatchObject({ code: 'credential_unavailable' });

    const down: VaultFetch = async () => {
      throw new Error('ECONNREFUSED 10.0.0.1:8200 secret/path');
    };
    const offline = makeStore(fakeVault(), [newKek()], { fetch: down });
    const err = (await offline.list(ALICE).catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: 'credential_unavailable' });
    expect(err.message).not.toMatch(/ECONNREFUSED|secret\/path/);

    const html: VaultFetch = async () => ({ status: 502, text: async () => '<html>bad gateway' });
    await expect(
      makeStore(fakeVault(), [newKek()], { fetch: html }).list(ALICE),
    ).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it('reads a soft-deleted latest version as absent, and writes over it with that version as cas', async () => {
    const v = fakeVault();
    const path = `moca/credentials/${subjectHash(ALICE)}`;
    v.kv.set(path, { version: 3, data: null });
    const store = makeStore(v, [newKek()]);
    expect(await store.list(ALICE)).toEqual([]);
    await store.put(ALICE, cred('github-work'));
    expect(JSON.parse(v.calls.at(-1)!.body!).options.cas).toBe(3);
  });

  it('a row copied to another subject`s path does not open (AAD)', async () => {
    const v = fakeVault();
    const store = makeStore(v, [newKek()]);
    await store.put(ALICE, cred('github-work'));
    const alice = v.kv.get(`moca/credentials/${subjectHash(ALICE)}`)!;
    v.kv.set(`moca/credentials/${subjectHash(BOB)}`, { ...alice });
    await expect(store.get(BOB, 'github-work')).rejects.toThrow(/failed to decrypt/);
  });

  it('refuses a malformed VAULT_ADDR or an empty mount/prefix at construction', () => {
    const v = fakeVault();
    expect(() => makeStore(v, [newKek()], { addr: 'vault:8200' })).toThrow(/VAULT_ADDR/);
    expect(() => makeStore(v, [newKek()], { addr: 'ftp://vault' })).toThrow(/VAULT_ADDR/);
    expect(() => makeStore(v, [newKek()], { mount: '//' })).toThrow(/SH_VAULT_KV_MOUNT/);
    expect(() => makeStore(v, [newKek()], { prefix: '' })).toThrow(/SH_VAULT_PATH/);
  });
});

describe('vaultTokenSource', () => {
  it('takes VAULT_TOKEN as-is', () => {
    expect(vaultTokenSource({ VAULT_TOKEN: TOKEN })()).toBe(TOKEN);
  });

  it('re-reads VAULT_TOKEN_FILE on every call, so a Vault Agent renewal is picked up', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cp-vault-')), 'token');
    writeFileSync(file, 'hvs.first\n'); // notsecret
    const source = vaultTokenSource({ VAULT_TOKEN_FILE: file });
    expect(await source()).toBe('hvs.first'); // notsecret
    writeFileSync(file, 'hvs.second'); // notsecret
    expect(await source()).toBe('hvs.second'); // notsecret
  });

  it('a token file emptied after startup fails that request as credential_unavailable', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cp-vault-')), 'token');
    writeFileSync(file, TOKEN);
    const store = makeStore(fakeVault(), [newKek()], {
      token: vaultTokenSource({ VAULT_TOKEN_FILE: file }),
    });
    expect(await store.list(ALICE)).toEqual([]);
    writeFileSync(file, '');
    await expect(store.list(ALICE)).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it('fails at startup on a missing or empty token file, on both settings, and on neither', () => {
    expect(() => vaultTokenSource({ VAULT_TOKEN_FILE: '/nonexistent/token' })).toThrow();
    const file = join(mkdtempSync(join(tmpdir(), 'cp-vault-')), 'token');
    writeFileSync(file, '  \n');
    expect(() => vaultTokenSource({ VAULT_TOKEN_FILE: file })).toThrow(/empty/);
    expect(() => vaultTokenSource({ VAULT_TOKEN: TOKEN, VAULT_TOKEN_FILE: file })).toThrow(
      /not both/,
    );
    expect(() => vaultTokenSource({})).toThrow(/VAULT_TOKEN/);
  });
});
