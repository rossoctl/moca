import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { KEK_BYTES, seal } from '../src/envelope.js';
import { parseCredentialBody, type StoredCredential } from '../src/credential-store.js';
import { K8sSecretStore, secretNameFor, subjectHash } from '../src/k8s-secret-store.js';
import type { RunKubectl } from '../src/kubectl.js';

const KEK = randomBytes(KEK_BYTES); // notsecret -- generated per run
const NS = 'sh-credentials';
const ALICE = 'github:1234';

const cred = (name: string, over: Record<string, unknown> = {}): StoredCredential =>
  parseCredentialBody(name, {
    kind: 'bearer',
    consumer: 'sandbox-egress',
    destination: { hosts: ['api.github.com'] },
    binding: { header: 'Authorization', format: 'Bearer {token}' },
    secret: { token: 'ghp-fake' }, // notsecret
    ...over,
  });

/**
 * A kubectl stand-in that keeps one in-memory Secret per name and honours exactly the three
 * operations the store performs (create / merge-patch / get -o json). It reproduces kubectl's own
 * asymmetry deliberately: a patch is written through `stringData`, but a read returns `data`
 * base64-encoded -- a fake that skipped that would let a base64 bug ship.
 */
/** Collect console.warn lines, the way exchange.test.ts collects the audit-gap console.error. */
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.join(' '));
  return { lines, restore: () => void (console.warn = original) };
}

function fakeCluster() {
  const secrets = new Map<
    string,
    { annotations: Record<string, string>; data: Record<string, string> }
  >();
  const calls: string[][] = [];
  const run: RunKubectl = async (args, stdin) => {
    calls.push(args);
    const [verb] = args;
    const name = verb === 'create' ? args[3]! : args[2]!;
    if (verb === 'create') {
      if (secrets.has(name))
        throw new Error(`Error from server (AlreadyExists): secrets "${name}" already exists`);
      secrets.set(name, { annotations: {}, data: {} });
      return '';
    }
    if (verb === 'patch') {
      const s = secrets.get(name);
      if (!s) throw new Error(`Error from server (NotFound): secrets "${name}" not found`);
      const patch = JSON.parse(stdin ?? '{}');
      // Real k8s Secrets: `data` is the persisted field; `stringData` is a write-only,
      // admission-time convenience the apiserver base64-encodes INTO `data` for non-null string
      // values and otherwise ignores entirely -- a null entry in `stringData` does NOT delete
      // the corresponding `data` key (only nulling `data` itself does). Modeling that asymmetry
      // is what makes this fake catch a delete() that nulls the wrong field and silently leaves
      // ciphertext behind, instead of masking it by "helpfully" honouring a stringData null.
      for (const [k, v] of Object.entries(patch.stringData ?? {})) {
        if (v !== null) s.data[k] = v as string;
      }
      for (const [k, v] of Object.entries(patch.data ?? {})) {
        if (v === null) delete s.data[k];
        else s.data[k] = v as string;
      }
      for (const [k, v] of Object.entries(patch.metadata?.annotations ?? {})) {
        if (v === null) delete s.annotations[k];
        else s.annotations[k] = v as string;
      }
      return '';
    }
    if (verb === 'get') {
      const s = secrets.get(name);
      if (!s) return ''; // --ignore-not-found
      return JSON.stringify({
        metadata: { name, annotations: s.annotations },
        data: Object.fromEntries(
          Object.entries(s.data).map(([k, v]) => [k, Buffer.from(v).toString('base64')]),
        ),
      });
    }
    if (verb === 'delete') {
      secrets.delete(name);
      return '';
    }
    throw new Error(`unexpected kubectl verb ${verb}`);
  };
  return { run, calls, secrets };
}

describe('secret naming', () => {
  it('derives the object name from the subject, so every access is a get by exact name', () => {
    expect(subjectHash(ALICE)).toBe(createHash('sha256').update(ALICE).digest('hex').slice(0, 16));
    expect(secretNameFor(ALICE)).toBe(`sh-cred-${subjectHash(ALICE)}`);
  });

  it('discloses no login in the object name', () => {
    // The name is a hash, so `kubectl get secrets` in the namespace reveals no GitHub identities
    // (spec §6.5) -- and reaching Bob's Secret requires already knowing Bob's subject.
    expect(secretNameFor('github:1234')).not.toContain('1234');
  });

  it('produces a valid Kubernetes object name', () => {
    expect(secretNameFor(ALICE)).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(secretNameFor(ALICE).length).toBeLessThanOrEqual(253);
  });
});

describe('K8sSecretStore', () => {
  let cluster: ReturnType<typeof fakeCluster>;
  let store: K8sSecretStore;

  beforeEach(() => {
    cluster = fakeCluster();
    store = new K8sSecretStore({ namespace: NS, keks: [KEK], run: cluster.run });
  });

  it('round-trips a two-header binding and a host:port/prefix destination', async () => {
    const c = cred('multi', {
      kind: 'api-key',
      destination: { hosts: ['svc.corp:8443/a'] },
      secret: { key: 'k' }, // notsecret
      binding: [
        { header: 'X-API-Key', format: '{key}' },
        { header: 'X-Org', format: 'acme-{key}' },
      ],
    });
    await store.put(ALICE, c);
    expect((await store.get(ALICE, 'multi'))?.descriptor).toEqual(c.descriptor);
    expect((await store.list(ALICE)).find((d) => d.name === 'multi')).toEqual(c.descriptor);
    expect(c.descriptor.destination.hosts).toEqual(['svc.corp:8443/a']);
  });

  it('round-trips put/get', async () => {
    await store.put(ALICE, cred('github-work'));
    const got = await store.get(ALICE, 'github-work');
    expect(got?.secret).toEqual({ token: 'ghp-fake' }); // notsecret
    expect(got?.descriptor).toEqual(cred('github-work').descriptor);
  });

  it('stores ciphertext, not the secret, in the Secret', async () => {
    await store.put(ALICE, cred('github-work'));
    const raw = JSON.stringify([...cluster.secrets.values()]);
    expect(raw).not.toContain('ghp-fake'); // notsecret
    expect(raw).toContain('v1.'); // the envelope version prefix
  });

  it('creates the Secret on first put and tolerates it already existing', async () => {
    await store.put(ALICE, cred('a'));
    await store.put(ALICE, cred('b'));
    expect(cluster.calls.filter((c) => c[0] === 'create')).toHaveLength(2); // attempted twice
    expect(await store.list(ALICE)).toHaveLength(2); // and both landed
  });

  it('adds a second credential without dropping the first (merge, not apply)', async () => {
    await store.put(ALICE, cred('a'));
    await store.put(ALICE, cred('b'));
    expect((await store.list(ALICE)).map((d) => d.name).sort()).toEqual(['a', 'b']);
    expect((await store.get(ALICE, 'a'))?.secret.token).toBe('ghp-fake'); // notsecret
  });

  it('keeps non-secret metadata in annotations, so list decrypts nothing', async () => {
    await store.put(
      ALICE,
      cred('my-anthropic', { consumer: 'inference', endpoint: 'https://litellm.internal/v1' }),
    );
    const secret = [...cluster.secrets.values()][0]!;
    expect(secret.annotations['sh.io/kind.my-anthropic']).toBe('bearer');
    expect(secret.annotations['sh.io/consumer.my-anthropic']).toBe('inference');
    expect(JSON.parse(secret.annotations['sh.io/destination.my-anthropic']!)).toEqual([
      'api.github.com',
    ]);
    expect(secret.annotations['sh.io/endpoint.my-anthropic']).toBe('https://litellm.internal/v1');

    const listed = await store.list(ALICE);
    // list() must not have needed the KEK: prove it by listing through a store built with a WRONG
    // key and still getting full descriptors back.
    const wrongKek = new K8sSecretStore({
      namespace: NS,
      keks: [randomBytes(KEK_BYTES)],
      run: cluster.run,
    });
    expect(await wrongKek.list(ALICE)).toEqual(listed);
  });

  describe('a KEK rotation, end to end through the store', () => {
    // The envelope tests prove seal/open handle a ring; these prove the store carries it, which is
    // what an operator actually performs. Before the ring, step 2 here was a total outage that no
    // /v1 route could recover from -- there is deliberately no read-back, so nothing could re-seal.
    it('still reads a credential written before the rotation, and re-seals it forward on the next write', async () => {
      const newKek = randomBytes(KEK_BYTES);

      // 1. Written under the old KEK alone.
      await store.put(ALICE, cred('my-anthropic'));

      // 2. Rotate: prepend the new KEK, keep the old one for reading.
      const rotating = new K8sSecretStore({ namespace: NS, keks: [newKek, KEK], run: cluster.run });
      expect((await rotating.get(ALICE, 'my-anthropic'))?.secret).toEqual({ token: 'ghp-fake' }); // notsecret

      // 3. The next write re-seals under the new KEK, so the old one is no longer needed for it.
      await rotating.put(ALICE, cred('my-anthropic'));
      const newOnly = new K8sSecretStore({ namespace: NS, keks: [newKek], run: cluster.run });
      expect((await newOnly.get(ALICE, 'my-anthropic'))?.secret).toEqual({ token: 'ghp-fake' }); // notsecret

      // 4. And the retired KEK alone no longer opens it -- the rotation actually moved.
      const oldOnly = new K8sSecretStore({ namespace: NS, keks: [KEK], run: cluster.run });
      await expect(oldOnly.get(ALICE, 'my-anthropic')).rejects.toThrow(/decrypt/i);
    });

    it('says out loud when a credential opened under a NON-PRIMARY key, naming the subject hash', async () => {
      // This is what makes step (c) of the rotation performable. `open` knows the ring index and used
      // to discard it, so an operator's only signal that they had dropped the retired key too early
      // was the outage it caused -- and that log names the user-chosen credential NAME, which
      // collides freely across subjects, so they could not enumerate whose credential was broken.
      //
      // Deliberately not deduplicated: the terminating condition is "no non-primary open for N days",
      // and a once-per-process log would let a long-lived pod satisfy it while credentials were still
      // stale.
      await store.put(ALICE, cred('my-anthropic'));
      const rotating = new K8sSecretStore({
        namespace: NS,
        keks: [randomBytes(KEK_BYTES), KEK],
        run: cluster.run,
      });

      const warned = captureWarn();
      try {
        expect((await rotating.get(ALICE, 'my-anthropic'))?.secret).toEqual({ token: 'ghp-fake' }); // notsecret
        await rotating.get(ALICE, 'my-anthropic'); // every read reports, not just the first
      } finally {
        warned.restore();
      }

      expect(warned.lines).toHaveLength(2);
      const line = warned.lines[0]!;
      expect(line).toContain(subjectHash(ALICE)); // WHOSE, without disclosing a login
      expect(line).toContain('credential=my-anthropic');
      // `ring index 1`, not a bare `1`: the subject hash is hex and contains digits, so `toContain('1')`
      // would be satisfied by the hash alone and could not fail.
      expect(line).toContain('ring index 1');
      expect(line).not.toContain(ALICE); // the raw subject is a login; the hash is what names it
      expect(line).not.toContain('ghp-fake'); // notsecret -- and never the value it just opened
    });

    it('stays silent once everything is re-sealed, or the signal would be worthless', async () => {
      // "No non-primary open for N days" only terminates the rotation if the steady state is silent.
      await store.put(ALICE, cred('my-anthropic'));
      const warned = captureWarn();
      try {
        expect((await store.get(ALICE, 'my-anthropic'))?.secret.token).toBe('ghp-fake'); // notsecret
      } finally {
        warned.restore();
      }
      expect(warned.lines).toEqual([]);
    });

    it('names the subject hash when NO key opens it, so the affected users are enumerable', async () => {
      // The failure case the signal above exists to prevent. envelope.ts keeps its message opaque for
      // a CALLER, and this adds nothing a caller sees -- writeError reduces a non-CpError to a bare
      // `internal_error` with no message -- but the operator log gets the one field that identifies
      // who must re-enter their credential.
      await store.put(ALICE, cred('my-anthropic'));
      const dropped = new K8sSecretStore({
        namespace: NS,
        keks: [randomBytes(KEK_BYTES)],
        run: cluster.run,
      });
      const err = await dropped.get(ALICE, 'my-anthropic').then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error); // it must throw at all, not read as absent
      // Exact, because this line is read by an operator and both halves are load-bearing: the name
      // says WHAT, the hash says WHOSE. Matching the whole string is also what pins the absence of
      // the raw subject -- a login -- rather than asserting it separately.
      expect(err?.message).toBe(
        `failed to decrypt credential 'my-anthropic' for subject ${subjectHash(ALICE)}`,
      );
      expect((err?.cause as Error).message).toBe("failed to decrypt credential 'my-anthropic'");
    });

    it('refuses a credential sealed under a KEK that is in no ring, rather than returning null', async () => {
      // A miss must not look like "no such credential": that would silently drop a credential the
      // user can see in list() and cannot use, with no signal to the operator.
      await store.put(ALICE, cred('my-anthropic'));
      const unrelated = new K8sSecretStore({
        namespace: NS,
        keks: [randomBytes(KEK_BYTES), randomBytes(KEK_BYTES)],
        run: cluster.run,
      });
      await expect(unrelated.get(ALICE, 'my-anthropic')).rejects.toThrow(/decrypt/i);
    });
  });

  it('every annotation key it writes is a valid Kubernetes annotation name', async () => {
    await store.put(ALICE, cred('a'.repeat(40)));
    for (const key of Object.keys([...cluster.secrets.values()][0]!.annotations)) {
      const [prefix, nameHalf] = key.split('/');
      expect(prefix).toBe('sh.io');
      expect(nameHalf!.length, key).toBeLessThanOrEqual(63);
      expect(nameHalf, key).toMatch(/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/);
    }
  });

  it('returns null for an unknown name and for a subject with no Secret at all', async () => {
    expect(await store.get(ALICE, 'nope')).toBeNull();
    expect(await store.get('github:9999', 'nope')).toBeNull();
    expect(await store.list('github:9999')).toEqual([]);
  });

  it('deletes one credential and leaves the others', async () => {
    await store.put(ALICE, cred('a'));
    await store.put(ALICE, cred('b'));
    await store.delete(ALICE, 'a');
    expect(await store.get(ALICE, 'a')).toBeNull();
    expect((await store.get(ALICE, 'b'))?.secret.token).toBe('ghp-fake'); // notsecret
    // The now-unused annotations go too, or list() would report a credential with no value.
    expect(Object.keys([...cluster.secrets.values()][0]!.annotations).join()).not.toContain('.a');
    // And the encrypted value itself is actually gone from the Secret -- not just annotation-less
    // and therefore invisible to list()/get(). Nulling the wrong field (stringData, a write-only
    // admission-time alias for `data`) leaves the ciphertext in the object forever; only nulling
    // `data` itself removes it.
    expect([...cluster.secrets.values()][0]!.data.a).toBeUndefined();
  });

  it('deletes idempotently, including for a subject that never had a Secret', async () => {
    await store.delete(ALICE, 'a');
    await store.delete('github:9999', 'a');
  });

  it('never lists Secrets to answer list(), only gets one by name', async () => {
    await store.put(ALICE, cred('a'));
    await store.list(ALICE);
    const secretVerbs = cluster.calls.filter((c) => c[1] === 'secret' || c[1] === 'secrets');
    for (const args of secretVerbs) {
      expect(args.includes('-l'), args.join(' ')).toBe(false);
    }
  });

  it('surfaces a relabel attack as a decrypt failure rather than a wrong credential', async () => {
    // An attacker with Secret WRITE moves Alice's ciphertext into Bob's Secret under the same name.
    await store.put(ALICE, cred('my-anthropic'));
    const aliceCipher = [...cluster.secrets.values()][0]!.data['my-anthropic']!;
    await cluster.run(buildBobSecret());
    cluster.secrets.set(secretNameFor('github:9999'), {
      annotations: {
        'sh.io/kind.my-anthropic': 'bearer',
        'sh.io/consumer.my-anthropic': 'inference',
        'sh.io/destination.my-anthropic': JSON.stringify(['api.github.com']),
        'sh.io/binding.my-anthropic': JSON.stringify({
          header: 'Authorization',
          format: 'Bearer {token}',
        }),
      },
      data: { 'my-anthropic': aliceCipher },
    });
    await expect(store.get('github:9999', 'my-anthropic')).rejects.toThrow(/decrypt/i);

    function buildBobSecret(): string[] {
      return ['create', 'secret', 'generic', secretNameFor('github:9999'), '-n', NS];
    }
  });

  it('rejects ciphertext sealed under a different KEK', async () => {
    await store.put(ALICE, cred('a'));
    const other = new K8sSecretStore({
      namespace: NS,
      keks: [randomBytes(KEK_BYTES)],
      run: cluster.run,
    });
    await expect(other.get(ALICE, 'a')).rejects.toThrow(/decrypt/i);
  });

  describe('the read cache, which is what makes a per-request redemption affordable', () => {
    // Every read forks kubectl. MI1 §6.3's inference listener redeems a grant on EVERY request a
    // worker sends to the provider, so without this a few concurrent turns mean a process fork per
    // completion.
    const gets = () => cluster.calls.filter((c) => c[0] === 'get').length;
    let clock: number;
    const cached = () =>
      new K8sSecretStore({ namespace: NS, keks: [KEK], run: cluster.run, now: () => clock });

    beforeEach(() => void (clock = 1_000_000));

    it('serves repeated reads of the same subject from one kubectl call', async () => {
      await store.put(ALICE, cred('a')); // through `store`, so nothing is cached yet
      const s = cached();
      expect((await s.get(ALICE, 'a'))?.secret.token).toBe('ghp-fake'); // notsecret
      const after = gets();
      for (let i = 0; i < 20; i++) await s.get(ALICE, 'a');
      await s.list(ALICE);
      expect(gets()).toBe(after);
    });

    it('collapses concurrent reads into a single call, not one per caller', async () => {
      await store.put(ALICE, cred('a'));
      const s = cached();
      const before = gets();
      await Promise.all(Array.from({ length: 10 }, () => s.get(ALICE, 'a')));
      expect(gets()).toBe(before + 1);
    });

    it('re-reads once the entry is older than the TTL', async () => {
      await store.put(ALICE, cred('a'));
      const s = cached();
      await s.get(ALICE, 'a');
      const after = gets();
      clock += 3_001;
      await s.get(ALICE, 'a');
      expect(gets()).toBe(after + 1);
    });

    it('re-reads at once after a write this store made, so a re-entered key is never stale', async () => {
      const s = cached();
      await s.put(ALICE, cred('a'));
      await s.get(ALICE, 'a');
      const after = gets();
      await s.put(ALICE, cred('a', { secret: { token: 'ghp-rotated' } })); // notsecret
      expect((await s.get(ALICE, 'a'))?.secret.token).toBe('ghp-rotated'); // notsecret
      expect(gets()).toBe(after + 1);
      await s.delete(ALICE, 'a');
      expect(await s.get(ALICE, 'a')).toBeNull();
    });

    it('does not cache a failure, so a momentary outage is not this subject`s answer for 3s', async () => {
      let dead = true;
      const s = new K8sSecretStore({
        namespace: NS,
        keks: [KEK],
        now: () => clock,
        run: async (args, stdin) => {
          if (dead && args[0] === 'get') throw new Error('connection refused');
          return cluster.run(args, stdin);
        },
      });
      await store.put(ALICE, cred('a'));
      await expect(s.get(ALICE, 'a')).rejects.toThrow();
      dead = false;
      expect((await s.get(ALICE, 'a'))?.secret.token).toBe('ghp-fake'); // notsecret
    });

    it('stays bounded when more subjects are read than it holds', async () => {
      const s = cached();
      for (let i = 0; i < 400; i++) await s.get(`github:${i}`, 'a');
      // Nothing to assert from outside but the absence of unbounded growth; the field is private, so
      // reach for it once rather than widening the class's surface for a test.
      const held = (s as unknown as { reads: Map<string, unknown> }).reads;
      expect(held.size).toBeLessThanOrEqual(256);
    });
  });

  it('ignores a data key with no descriptor annotations when listing', async () => {
    // Something else wrote a stray key into the Secret. It must not appear as a credential with an
    // invented descriptor -- list() reports only what it can describe.
    await store.put(ALICE, cred('a'));
    [...cluster.secrets.values()][0]!.data['stray'] = seal([KEK], ALICE, 'stray', 'x');
    expect((await store.list(ALICE)).map((d) => d.name)).toEqual(['a']);
  });
});

describe('the credential store answers 503, not 500, when kubectl or the API is the problem', () => {
  // credential_unavailable (503) already existed in the taxonomy and nothing on the control-plane side
  // mapped to it. An unreachable API server, an expired ServiceAccount token or a 403 from a narrowed
  // Role are all "the store is not answering" -- retryable -- and escaping as a plain Error made every
  // one of them a 500 internal_error, which claims the control plane is broken.
  const storeWith = (run: RunKubectl) => new K8sSecretStore({ namespace: NS, keks: [KEK], run });
  const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
    } catch (e) {
      return (e as { code?: string }).code ?? `UNTYPED:${(e as Error).name}`;
    }
    throw new Error('expected a throw');
  };

  it('maps a kubectl failure on every read and write path', async () => {
    const dead: RunKubectl = async () => {
      throw new Error('The connection to the server 10.0.0.1:6443 was refused');
    };
    const s = storeWith(dead);
    expect(await codeOf(() => s.get(ALICE, 'a'))).toBe('credential_unavailable');
    expect(await codeOf(() => s.list(ALICE))).toBe('credential_unavailable');
    expect(await codeOf(() => s.delete(ALICE, 'a'))).toBe('credential_unavailable');
    // put() goes through ensureSecret first, whose catch must distinguish an outage from AlreadyExists.
    expect(await codeOf(() => s.put(ALICE, cred('a')))).toBe('credential_unavailable');
  });

  it('never leaks kubectl stderr into the message, which can name a token or a resource', async () => {
    const dead: RunKubectl = async () => {
      throw new Error('error: secrets "sh-cred-deadbeef" is forbidden: token ghp-leaked'); // notsecret
    };
    try {
      await storeWith(dead).list(ALICE);
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).not.toContain('ghp-leaked'); // notsecret
      expect((e as Error).message).not.toContain('sh-cred-deadbeef');
    }
  });

  it('maps malformed kubectl output to 503 rather than letting a SyntaxError become 500', async () => {
    // A proxy's HTML error page or a truncated read is not a control-plane bug.
    for (const body of [
      '<html>502 Bad Gateway</html>',
      '{"metadata":',
      '[]',
      'null',
      '"a string"',
    ]) {
      const s = storeWith(async () => body);
      expect(await codeOf(() => s.list(ALICE)), body).toBe('credential_unavailable');
    }
  });

  it('rejects a right-shaped object whose metadata or data is the wrong type', async () => {
    for (const body of ['{"metadata":"nope"}', '{"data":[1,2]}']) {
      const s = storeWith(async () => body);
      expect(await codeOf(() => s.list(ALICE)), body).toBe('credential_unavailable');
    }
  });

  it('still treats empty output as "no such Secret" rather than an outage', async () => {
    // `get --ignore-not-found` prints nothing for a subject who has never stored anything, and that is
    // a valid empty answer -- turning it into a 503 would break every first-time user.
    const s = storeWith(async () => '   \n');
    expect(await s.list(ALICE)).toEqual([]);
    expect(await s.get(ALICE, 'a')).toBeNull();
  });
});
