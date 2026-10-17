import { describe, expect, it } from 'vitest';
import { MemorySandboxStore } from '../src/sandbox-store.js';
import { sandboxStoreContract } from './helpers/sandbox-store-contract.js';

sandboxStoreContract('memory', async () => ({
  store: new MemorySandboxStore(),
  done: async () => {},
}));

describe('MemorySandboxStore retention', () => {
  it('forgets a terminated record once its retention has passed', async () => {
    const store = new MemorySandboxStore();
    const rec = {
      id: 'sbx-r',
      owner: 'github:1',
      tenant: 'github:1',
      name: '',
      template: 'default',
      worker: 'sbx_default',
      wsk: 'sbx-r',
      labels: {},
      createdAt: 100,
      expiresAt: 200,
    };
    await store.create(rec, { perSubject: 1, total: 1, retentionS: 50 }, 100);
    expect(await store.markDeleted('sbx-r', 150, 50)).toBe('deleted');
    expect(await store.get('sbx-r', 199)).not.toBeNull();
    // Gone AT terminatedAt + retention, as a Redis key with EXPIREAT t is gone at t.
    expect(await store.get('sbx-r', 200)).toBeNull();
    expect(await store.get('sbx-r', 201)).toBeNull();
  });
});
