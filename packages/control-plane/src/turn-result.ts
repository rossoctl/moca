/**
 * Reading a leaf's result for the status route (async spec §4.4). The result store belongs to
 * `@moca/harness` (`harness/src/leaf-result-store.ts`), which the control plane does NOT depend on
 * and must not: the control plane sits below the harness, and importing upward would invert the
 * layering for one `GET`. So the key shape and the two methods are declared here -- the same key
 * `ownership.ts`'s `dataKeys` already lists, and `cascadeDelete` already removes.
 */
export interface ResultRedisLike {
  get(key: string): Promise<string | null>;
}

/** The harness's `resultKey` (leaf-result-store.ts:25), restated rather than imported. */
export const leafResultKey = (leafSessionId: string): string => `leaf:result:${leafSessionId}`;

/**
 * The stored record, or null when the leaf has not written one. A corrupt value reads as absent:
 * the record's own `state` is the single source of truth for status (§4.4), so a malformed result
 * must degrade to "no result yet" rather than fail the whole read.
 */
export async function readLeafResult(
  redis: ResultRedisLike,
  leafSessionId: string,
): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(leafResultKey(leafSessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
