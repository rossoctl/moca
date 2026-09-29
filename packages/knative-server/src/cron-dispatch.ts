import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Replace every __FIRE__ in each string field with fireId; non-strings pass through. Pure, non-mutating. */
export function applyFire(
  envelope: Record<string, unknown>,
  fireId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) {
    out[k] = typeof v === 'string' ? v.split('__FIRE__').join(fireId) : v;
  }
  return out;
}

/**
 * Dispatch every config item as an async leaf. Each item is fire-substituted and POSTed with
 * async:true via the injected `post` (returns true iff the dispatch was accepted). Every item is
 * attempted even if earlier ones fail; a thrown post counts as a failure.
 */
export async function dispatchAll(
  items: Record<string, unknown>[],
  fireId: string,
  post: (env: Record<string, unknown>) => Promise<boolean>,
): Promise<{ total: number; accepted: number; failed: number }> {
  let accepted = 0;
  let failed = 0;
  for (const item of items) {
    const env = { ...applyFire(item, fireId), async: true };
    try {
      (await post(env)) ? accepted++ : failed++;
    } catch {
      failed++;
    }
  }
  return { total: items.length, accepted, failed };
}

export function exitCodeFor(result: { failed: number }): number {
  return result.failed > 0 ? 1 : 0;
}

export function loadConfig(path: string): Record<string, unknown>[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed?.items)) throw new Error("cron config: 'items' must be an array");
  return parsed.items as Record<string, unknown>[];
}

/**
 * Build the real POST function: fetch the in-cluster Knative service; accepted == 202 + {status:"accepted"}.
 * Items now carry an inline `item` object (e.g. { item_id, file, pattern }) rather than
 * `inputsRef`/`resultRef` file-system references. `dispatchAll` is shape-agnostic and
 * passes whatever the config provides through unchanged (after __FIRE__ substitution).
 */
function buildPost(): (env: Record<string, unknown>) => Promise<boolean> {
  const base = process.env.SH_SERVICE_URL ?? 'http://moca.default.svc.cluster.local';
  return async (env) => {
    const res = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(env),
    });
    if (res.status !== 202) {
      console.error(`dispatch rejected: HTTP ${res.status}`);
      return false;
    }
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    return (body as Record<string, unknown>).status === 'accepted';
  };
}

async function main(): Promise<void> {
  const fireId = process.env.JOB_NAME ?? `manual-${process.pid}`;
  const configPath = process.env.CRON_CONFIG ?? '/config/schedule.json';
  const items = loadConfig(configPath);
  if (items.length === 0)
    console.warn(`cron-dispatch: config has no items — nothing to dispatch (fire=${fireId})`);
  const result = await dispatchAll(items, fireId, buildPost());
  console.log(
    `cron-dispatch: ${result.accepted}/${result.total} accepted, ${result.failed} failed (fire=${fireId})`,
  );
  process.exit(exitCodeFor(result));
}

// Only run when invoked as the entrypoint (so tests can import the pure helpers above).
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error('cron-dispatch error:', err);
    process.exit(1);
  });
}
