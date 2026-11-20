import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileCredentialStore } from '../src/file-store.js';
import { subjectHash } from '../src/subject-document.js';
import { ALICE, BOB, cred, newKek, storeContract } from './helpers/store-contract.js';

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'cp-file-store-'));

storeContract('FileCredentialStore', () => {
  const dir = freshDir();
  return {
    storeWith: (keks) => new FileCredentialStore({ dir, keks }),
    raw: () =>
      readdirSync(dir)
        .map((f) => readFileSync(join(dir, f), 'utf8'))
        .join('\n'),
    plant: (subject, edit) => {
      const file = join(dir, `${subjectHash(subject)}.json`);
      writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, 'utf8')))));
    },
  };
});

describe('FileCredentialStore', () => {
  it('creates a missing directory 0700, and writes each subject`s file 0600', async () => {
    const dir = join(freshDir(), 'nested', 'creds');
    const store = new FileCredentialStore({ dir, keks: [newKek()] });
    await store.put(ALICE, cred('github-work'));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const file = join(dir, `${subjectHash(ALICE)}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Only the subject's own file: the temp file was renamed over it, not left behind.
    expect(readdirSync(dir)).toEqual([`${subjectHash(ALICE)}.json`]);
  });

  it('refuses at construction when the directory is not writable', () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits this relies on
    const dir = freshDir();
    chmodSync(dir, 0o500);
    try {
      expect(() => new FileCredentialStore({ dir, keks: [newKek()] })).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('refuses an empty directory setting', () => {
    expect(() => new FileCredentialStore({ dir: '', keks: [newKek()] })).toThrow(
      /SH_CREDENTIAL_DIR/,
    );
  });

  it('survives a new process: a fresh store over the same directory reads what the last one wrote', async () => {
    const dir = freshDir();
    const kek = newKek();
    await new FileCredentialStore({ dir, keks: [kek] }).put(ALICE, cred('github-work'));
    expect(
      (await new FileCredentialStore({ dir, keks: [kek] }).get(ALICE, 'github-work'))?.secret,
    ).toEqual({ token: 'ghp-fake' }); // notsecret
  });

  it('a file relabelled to another subject does not open: the AAD binds the ciphertext to its subject', async () => {
    const dir = freshDir();
    const store = new FileCredentialStore({ dir, keks: [newKek()] });
    await store.put(ALICE, cred('github-work'));
    // An attacker with write access to the volume, but not the KEK, copies Alice's row into Bob's.
    copyFileSync(join(dir, `${subjectHash(ALICE)}.json`), join(dir, `${subjectHash(BOB)}.json`));
    expect((await store.list(BOB)).map((d) => d.name)).toEqual(['github-work']);
    await expect(store.get(BOB, 'github-work')).rejects.toThrow(/failed to decrypt/);
  });

  it('a corrupt file is credential_unavailable (503), not a 500', async () => {
    const dir = freshDir();
    const store = new FileCredentialStore({ dir, keks: [newKek()] });
    writeFileSync(join(dir, `${subjectHash(ALICE)}.json`), '{not json');
    await expect(store.list(ALICE)).rejects.toMatchObject({ code: 'credential_unavailable' });
    writeFileSync(join(dir, `${subjectHash(ALICE)}.json`), JSON.stringify({ v: 2 }));
    await expect(store.list(ALICE)).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it('skips a malformed entry rather than locking the subject out of the rest', async () => {
    const dir = freshDir();
    const store = new FileCredentialStore({ dir, keks: [newKek()] });
    await store.put(ALICE, cred('good'));
    const file = join(dir, `${subjectHash(ALICE)}.json`);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    doc.credentials.bad = { descriptor: { name: 'bad' }, sealed: 'v1.x.y.z' };
    doc.credentials.misnamed = { ...doc.credentials.good };
    writeFileSync(file, JSON.stringify(doc));
    expect((await store.list(ALICE)).map((d) => d.name)).toEqual(['good']);
    expect(await store.get(ALICE, 'bad')).toBeNull();
  });

  it('a failing write is credential_unavailable and leaves no temp file behind', async () => {
    if (process.getuid?.() === 0) return;
    const dir = freshDir();
    const store = new FileCredentialStore({ dir, keks: [newKek()] });
    await store.put(ALICE, cred('one'));
    chmodSync(dir, 0o500);
    try {
      await expect(store.put(ALICE, cred('two'))).rejects.toMatchObject({
        code: 'credential_unavailable',
      });
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readdirSync(dir)).toEqual([`${subjectHash(ALICE)}.json`]);
    expect((await store.list(ALICE)).map((d) => d.name)).toEqual(['one']);
  });

  it('a failed operation does not wedge the subject`s queue', async () => {
    if (process.getuid?.() === 0) return;
    const dir = freshDir();
    const store = new FileCredentialStore({ dir, keks: [newKek()] });
    chmodSync(dir, 0o500);
    const failed = store.put(ALICE, cred('one'));
    await expect(failed).rejects.toBeTruthy();
    chmodSync(dir, 0o700);
    await store.put(ALICE, cred('two'));
    expect((await store.list(ALICE)).map((d) => d.name)).toEqual(['two']);
  });
});
