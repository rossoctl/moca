import { describe, it, expect, afterAll } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from 'redis';
import { buildBundle } from '@moca/config-bundle';
import { putBundle, type BundleRedisLike } from '../src/config-store.js';
import { runLeaf } from '../src/run-leaf.js';

// harness/package.json is "type": "module", so bare __dirname is undefined here; derive it the
// way fixtures.test.ts and config-resolver.test.ts do.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Gated exactly like pool-live-smoke.test.ts / m3-live-smoke.test.ts: needs a cluster, a
// sandbox pool, and a real model.
const LIVE =
  process.env.SH_PROMOTE_LIVE_SMOKE === '1' &&
  !!process.env.ANTHROPIC_AUTH_TOKEN &&
  !!process.env.KAGENTI_SANDBOX_POOL_SELECTOR;

const FIXTURES = join(__dirname, 'fixtures', 'promoted');
// Typed by the one method the teardown below uses, in the spirit of RedisLike /
// BundleRedisLike elsewhere in this package. `ReturnType<typeof createClient>` looks tighter
// but is not: createClient() and createClient({ url }) resolve to differently-parameterized
// RedisClientTypes, so pushing the latter into an array of the former does not typecheck.
const clients: Array<{ quit(): Promise<unknown> }> = [];

afterAll(async () => {
  for (const c of clients) await c.quit();
});

// Session ids here must NOT use the `<run>/<item>` shape seen in leaf-smoke.sh and the leaf
// fixtures. Those go through an item envelope, where `leafSessionId` derives a sanitized id; these
// call `runLeaf` with `kind: 'prompt'`, whose sessionId is used verbatim as the session key and is
// validated against `[alnum][alnum._-]*[alnum]`. With a slash, the first test failed in 597 ms with
// "Session id must be non-empty, contain only alphanumeric characters..." -- before any model call,
// so it never reached the assertion it exists to make. The second test passed only incidentally:
// an unknown digest fails before session-id validation is reached, so its `toContain('not found')`
// held while its id was equally invalid.
describe('promoted workflow, end to end', () => {
  it.runIf(LIVE)(
    'runs a promoted skill that reads its own sibling file in the sandbox',
    async () => {
      const built = buildBundle({
        roots: { userDir: FIXTURES },
        promptsDir: join(FIXTURES, 'commands'),
        entry: 'say-the-word',
        mode: 'unattended',
        sandboxImage: 'ghcr.io/rossoctl/moca-sandbox:latest',
        versions: { pi: 'live', harness: 'live' },
      });
      expect(built.findings.filter((f) => f.severity === 'error')).toEqual([]);

      const client = createClient({ url: process.env.REDIS_URL });
      clients.push(client);
      await client.connect();
      await putBundle(client as unknown as BundleRedisLike, built.digest, built.tar);

      const result = await runLeaf({
        sessionId: `promote-smoke-${Date.now()}`,
        item: { item_id: 'i1', file: 'f', pattern: 'p' },
        kind: 'prompt',
        prompt: 'Reply with exactly the secret word and nothing else.',
        configRef: built.digest,
      } as never);

      // THE assertion that matters: the model could only produce this word by resolving a
      // relative path from a promoted skill's instructions against the absolute skills-directory
      // path the leaf injects into the prompt (run-leaf.ts) for that skill's own subdirectory in
      // the sandbox. It proves path translation (spec §4.5) end to end.
      expect(result.status).toBe('responded');
      expect((result as { text: string }).text).toContain('PROMOTED-SIBLING-OK');
    },
    180_000,
  );

  it.runIf(LIVE)('fails loudly on an unknown digest instead of running unconfigured', async () => {
    const result = await runLeaf({
      sessionId: `promote-smoke-missing-${Date.now()}`,
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
      kind: 'prompt',
      prompt: 'anything',
      configRef: 'sha256:' + 'f'.repeat(64),
    } as never);
    expect(result.status).toBe('failed');
    expect((result as { message: string }).message).toContain('not found');
  });
});
