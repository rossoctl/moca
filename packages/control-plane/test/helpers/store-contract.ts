import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asyncCounters, resetAsyncCounters } from '../../src/counters.js';
import { KEK_BYTES } from '../../src/envelope.js';
import {
  parseCredentialBody,
  type CredentialStore,
  type StoredCredential,
} from '../../src/credential-store.js';

export const ALICE = 'github:1234';
export const BOB = 'github:5678';

export const cred = (name: string, over: Record<string, unknown> = {}): StoredCredential =>
  parseCredentialBody(name, {
    kind: 'bearer',
    consumer: 'sandbox-egress',
    destination: { hosts: ['api.github.com'] },
    binding: { header: 'Authorization', format: 'Bearer {token}' },
    secret: { token: 'ghp-fake' }, // notsecret
    ...over,
  });

export const newKek = (): Buffer => randomBytes(KEK_BYTES); // notsecret -- generated per run

/**
 * The CredentialStore contract every backend must meet (credential-store.ts, spec §6.2/§6.5), run
 * against each store's REAL implementation over its fake backend. `backend()` makes one fresh backend;
 * its `storeWith(keks)` builds a store over THAT backend (so a KEK rotation is a second store over the
 * same bytes), and `raw()` returns every byte currently at rest, so the suite can assert what an
 * attacker who reads the backend -- but not the KEK -- actually sees.
 */
export interface ContractBackend {
  storeWith: (keks: Buffer[]) => CredentialStore;
  raw: () => string;
  /**
   * Rewrite `subject`'s stored document in place, as another writer (a newer replica) would. Absent
   * for a store with no subject document (K8sSecretStore); the test that needs it is skipped.
   */
  plant?: (subject: string, edit: (doc: Record<string, any>) => Record<string, any>) => void;
}

export function storeContract(label: string, backend: () => ContractBackend): void {
  describe(`${label}: CredentialStore contract`, () => {
    let b: ContractBackend;
    beforeEach(() => {
      b = backend();
    });
    const make = (keks: Buffer[]) => ({ store: b.storeWith(keks), raw: b.raw, plant: b.plant });

    it('round-trips a credential by exact name, and an unknown name is null', async () => {
      const { store } = make([newKek()]);
      await store.put(ALICE, cred('github-work'));
      expect(await store.get(ALICE, 'github-work')).toEqual(cred('github-work'));
      expect(await store.get(ALICE, 'github')).toBeNull();
      expect(await store.get(ALICE, 'github-work-2')).toBeNull();
      expect(await store.get(BOB, 'github-work')).toBeNull();
    });

    it('round-trips a two-header binding and a host:port/prefix destination', async () => {
      const { store } = make([newKek()]);
      const c = cred('multi', {
        kind: 'api-key',
        destination: { hosts: ['svc.corp:8443/a'] },
        secret: { key: 'k' }, // notsecret
        binding: [
          { header: 'X-API-Key', format: '{key}' },
          { header: 'X-Org', format: 'acme-{key}' },
        ],
      });
      expect(c.descriptor.binding).toHaveLength(2);
      expect(c.descriptor.destination.hosts).toEqual(['svc.corp:8443/a']);
      await store.put(ALICE, c);
      expect(await store.get(ALICE, 'multi')).toEqual(c);
      expect(await store.list(ALICE)).toEqual([c.descriptor]);
    });

    it('treats Object.prototype names as absent, not as inherited members', async () => {
      const { store } = make([newKek()]);
      await store.put(ALICE, cred('github-work'));
      for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        expect(await store.get(ALICE, name), name).toBeNull();
      }
    });

    it('keeps subjects apart', async () => {
      const { store } = make([newKek()]);
      await store.put(ALICE, cred('shared-name', { secret: { token: 'alice-tok' } })); // notsecret
      await store.put(BOB, cred('shared-name', { secret: { token: 'bob-tok' } })); // notsecret
      expect((await store.get(ALICE, 'shared-name'))?.secret).toEqual({ token: 'alice-tok' }); // notsecret
      expect((await store.get(BOB, 'shared-name'))?.secret).toEqual({ token: 'bob-tok' }); // notsecret
      expect(await store.list('github:0')).toEqual([]);
    });

    it('lists descriptors only, sorted, and never the secret', async () => {
      const { store } = make([newKek()]);
      await store.put(ALICE, cred('zeta'));
      await store.put(ALICE, cred('alpha'));
      const listed = await store.list(ALICE);
      expect(listed.map((d) => d.name)).toEqual(['alpha', 'zeta']);
      expect(JSON.stringify(listed)).not.toContain('ghp-fake');
    });

    it('at rest, the descriptor is in the clear and the secret is not', async () => {
      const { store, raw } = make([newKek()]);
      await store.put(ALICE, cred('github-work'));
      expect(raw()).toContain('github-work');
      expect(raw()).toContain('api.github.com');
      expect(raw()).not.toContain('ghp-fake');
      expect(raw()).toContain('v1.'); // the envelope version prefix
      // Nor the login: every object is named by the subject HASH.
      expect(raw()).not.toContain(ALICE);
    });

    it('list never touches the KEK: a store with a KEK outside the ring still lists', async () => {
      await make([newKek()]).store.put(ALICE, cred('github-work'));
      const stranger = make([newKek()]).store;
      expect((await stranger.list(ALICE)).map((d) => d.name)).toEqual(['github-work']);
      await expect(stranger.get(ALICE, 'github-work')).rejects.toThrow(
        /failed to decrypt credential 'github-work' for subject [0-9a-f]{16}/,
      );
    });

    it('overwrites a credential in place and keeps the subject`s others', async () => {
      const { store } = make([newKek()]);
      await store.put(ALICE, cred('one'));
      await store.put(ALICE, cred('two'));
      await store.put(ALICE, cred('one', { secret: { token: 'rotated' } })); // notsecret
      expect((await store.get(ALICE, 'one'))?.secret).toEqual({ token: 'rotated' }); // notsecret
      expect((await store.get(ALICE, 'two'))?.secret).toEqual({ token: 'ghp-fake' }); // notsecret
    });

    it('concurrent puts for one subject lose nothing', async () => {
      const { store } = make([newKek()]);
      const names = Array.from({ length: 8 }, (_, i) => `cred-${i}`);
      await Promise.all(names.map((n) => store.put(ALICE, cred(n))));
      expect((await store.list(ALICE)).map((d) => d.name)).toEqual(names);
    });

    it('delete removes exactly one credential and its ciphertext; deleting an absent one is a no-op', async () => {
      const { store, raw } = make([newKek()]);
      await store.put(ALICE, cred('keep'));
      await store.put(ALICE, cred('drop', { secret: { token: 'drop-me-tok' } })); // notsecret
      await store.delete(ALICE, 'drop');
      await store.delete(ALICE, 'never-existed');
      await store.delete(BOB, 'anything');
      expect(await store.get(ALICE, 'drop')).toBeNull();
      expect((await store.list(ALICE)).map((d) => d.name)).toEqual(['keep']);
      expect(raw()).not.toContain('"drop"');
    });

    it('a write keeps what it cannot read: unreadable rows, unknown fields, other versions` data', async (ctx) => {
      const { store, plant, raw } = make([newKek()]);
      if (!plant) return ctx.skip();
      await store.put(ALICE, cred('known'));
      // What a NEWER replica might have written: a row in a shape this version cannot parse, an
      // extra descriptor field on a row it can, and a top-level field it has never heard of.
      plant(ALICE, (doc) => ({
        ...doc,
        futureTopLevel: { keep: true },
        credentials: {
          ...doc.credentials,
          'from-the-future': { descriptorV2: { name: 'from-the-future' }, sealedV2: 'opaque-v2' },
          known: {
            ...doc.credentials.known,
            descriptor: { ...doc.credentials.known.descriptor, rotationPolicy: 'weekly' },
          },
        },
      }));
      // Read paths skip the unreadable row and still see the rest.
      expect((await store.list(ALICE)).map((d) => d.name)).toEqual(['known']);
      expect(await store.get(ALICE, 'from-the-future')).toBeNull();

      await store.put(ALICE, cred('unrelated'));
      await store.delete(ALICE, 'unrelated');
      for (const kept of ['opaque-v2', 'sealedV2', 'futureTopLevel', 'rotationPolicy']) {
        expect(raw(), kept).toContain(kept);
      }
      expect((await store.get(ALICE, 'known'))?.secret).toEqual({ token: 'ghp-fake' }); // notsecret
    });

    describe('KEK rotation', () => {
      let warns: string[];
      const original = console.warn;
      beforeEach(() => {
        warns = [];
        console.warn = (...args: unknown[]) => void warns.push(args.join(' '));
        resetAsyncCounters();
      });
      afterEach(() => {
        console.warn = original;
        resetAsyncCounters();
      });

      const nonPrimaryReads = () => asyncCounters().credential_nonprimary_kek_reads;

      it('opens under a retired KEK and logs it, then re-seals forward on the next put', async () => {
        const oldKek = newKek();
        const newer = newKek();
        await make([oldKek]).store.put(ALICE, cred('github-work'));
        const rotated = make([newer, oldKek]).store;
        expect((await rotated.get(ALICE, 'github-work'))?.secret).toEqual({ token: 'ghp-fake' }); // notsecret
        expect(warns.join('\n')).toMatch(/NON-PRIMARY KEK ring index 1: subject=[0-9a-f]{16}/);
        await rotated.put(ALICE, cred('github-work'));
        // Now sealed under `newer`: the retired key can be dropped.
        warns.length = 0;
        expect(await make([newer]).store.get(ALICE, 'github-work')).not.toBeNull();
        expect(warns).toEqual([]);
        // And the retired key alone no longer opens it: the rotation actually moved.
        await expect(make([oldKek]).store.get(ALICE, 'github-work')).rejects.toThrow(/decrypt/);
      });

      /**
       * The counter is what an operator watches to decide the retired key is unused
       * (docs/operate/sandbox-service/runbook.md, "Rotating the credential KEK"), so it must track the
       * same transitions the log does: one per stale READ -- not deduplicated, or a long-lived process
       * would report zero while credentials were still stale -- and back to still once the entry has
       * been re-sealed forward.
       */
      it('counts every read under a retired KEK, and stops counting once re-sealed', async () => {
        const oldKek = newKek();
        const newer = newKek();
        await make([oldKek]).store.put(ALICE, cred('github-work'));
        expect(nonPrimaryReads()).toBe(0); // sealed and read under its own primary

        const rotated = make([newer, oldKek]).store;
        await rotated.get(ALICE, 'github-work');
        await rotated.get(ALICE, 'github-work');
        expect(nonPrimaryReads()).toBe(2);

        await rotated.put(ALICE, cred('github-work'));
        await rotated.get(ALICE, 'github-work');
        expect(nonPrimaryReads()).toBe(2);
      });

      /**
       * `list` decrypts nothing (spec §6.2), so it cannot see a retired key and must not report one.
       * The same store then READS the same stale entry and does count it -- otherwise this passes for
       * the uninteresting reason that nothing in the test opened a credential at all, which is true of
       * any implementation that counts only in `readCredential`.
       */
      it('counts a stale read but not the list that preceded it', async () => {
        const oldKek = newKek();
        await make([oldKek]).store.put(ALICE, cred('github-work'));
        const rotated = make([newKek(), oldKek]).store;
        expect((await rotated.list(ALICE)).map((d) => d.name)).toEqual(['github-work']);
        expect(nonPrimaryReads()).toBe(0);
        await rotated.get(ALICE, 'github-work');
        expect(nonPrimaryReads()).toBe(1);
      });
    });

    it('carries an inference credential`s endpoint through, and null elsewhere', async () => {
      const { store } = make([newKek()]);
      await store.put(
        ALICE,
        parseCredentialBody('my-anthropic', {
          kind: 'api-key',
          consumer: 'inference',
          destination: { hosts: ['api.anthropic.com'] },
          endpoint: 'https://api.anthropic.com',
          secret: { key: 'sk-ant-api03-fake' }, // notsecret
        }),
      );
      await store.put(ALICE, cred('github-work'));
      const [gh, inf] = await store.list(ALICE);
      expect(inf?.endpoint).toBe('https://api.anthropic.com');
      expect(gh?.endpoint).toBeNull();
    });
  });
}
