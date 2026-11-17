/**
 * Reading a leaf's result for the status route (async spec §4.4). The result store belongs to
 * `@moca/harness` (`harness/src/leaf-result-store.ts`), which the control plane does NOT depend on
 * and must not: the control plane sits below the harness, and importing upward would invert the
 * layering for one `GET`. So the key shape and the two methods are declared here.
 */
export interface ResultRedisLike {
  get(key: string): Promise<string | null>;
}

/**
 * The harness's `resultKey` with a turn id (leaf-result-store.ts:32), restated rather than imported.
 *
 * `turnId` is REQUIRED here, where it is optional in the harness: the harness also serves the
 * synchronous `/runs` path, where a session has one leaf at a time, while every key the control
 * plane reads or deletes belongs to an async turn. §4.3 lets one session hold several queued turns
 * at once (distinct `idempotencyKey`s), so a per-session key would let the second to finish answer
 * `GET …/turns/<first>` with its own body.
 */
export const leafResultKey = (leafSessionId: string, turnId: string): string =>
  `leaf:result:${leafSessionId}:${turnId}`;

/**
 * The stored record, or null when the leaf has not written one. A corrupt value reads as absent:
 * the record's own `state` is the single source of truth for status (§4.4), so a malformed result
 * must degrade to "no result yet" rather than fail the whole read.
 */
export async function readLeafResult(
  redis: ResultRedisLike,
  leafSessionId: string,
  turnId: string,
): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(leafResultKey(leafSessionId, turnId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return obj(parsed);
  } catch {
    return null;
  }
}

/** An object, or null for anything else (array and scalar included). */
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Clip to a UTF-8 byte cap, the `…[truncated]` convention of `harness/src/turn-stream.ts`'s `clip`
 * — restated, not imported, for the layering reason this module's header gives. Bytes, not tokens:
 * every bound in this repo is bytes, and the clip must hold whatever the model wrote.
 *
 * `maxBytes` bounds the CONTENT; the marker is 14 bytes on top of it, so a clipped field is up to
 * `maxBytes + 14`. Docs say so too — the cap is not a bound on the field's total length.
 *
 * `subarray` can land mid-codepoint; `toString('utf8')` replaces the partial tail with U+FFFD
 * rather than emitting invalid UTF-8, so the result is always a well-formed string under the cap.
 */
export function clip(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString('utf8') + '…[truncated]';
}

/** What `GET …/turns/{turnId}/artifacts/{kind}` can serve for this result. */
export interface TurnArtifact {
  kind: 'patch';
  bytes: number;
  sha256?: string;
}

/** The bytes of one artifact, ready to write. */
export interface ArtifactBody {
  bytes: Buffer;
  contentType: string;
  /**
   * The CAPTURE's digest of exactly these bytes, when the record carries one — so the route can
   * answer with an `ETag` without hashing a multi-megabyte buffer on the event loop per request.
   * It is the same value `artifacts[].sha256` advertises, so the two cannot disagree.
   */
  sha256?: string;
}

/** Unified diffs, the only artifact kind in M1. `text/x-diff` is what git's own tooling serves. */
const PATCH_CONTENT_TYPE = 'text/x-diff';

/**
 * The status read's body (§4.4, B5): everything the stored record says ABOUT the turn, and nothing
 * that is the turn's output in full. A 4 MiB patch rode every poll before this; now the patch and
 * the assistant text leave the body and `artifacts` names what can be fetched instead.
 *
 * Read-time only. Nothing new is stored, so there is no second writer, no migration, and a record
 * written by an older worker projects the same way as a new one.
 */
export function projectLeafResult(
  raw: Record<string, unknown>,
  summaryBytes: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Drop the two big fields and keep the rest: `status`, `reason`, `usage`, `seed`, `sessionId` and
  // `ts` are bounded by construction (a short enum, counters, two ids, a timestamp), and a caller
  // that reads one of them today must keep reading it.
  for (const [k, v] of Object.entries(raw)) {
    if (k !== 'patch' && k !== 'text' && k !== 'workspace') out[k] = v;
  }
  // `verdict.reason` and the gate's two strings are the exception: they are MODEL-written and
  // capped nowhere (`validateVerdict` checks the shape, not the length), so unclipped they ride
  // every poll -- the cost this projection exists to remove. Clipped rather than moved out: there
  // is no artifact route for them, so this body is all a caller gets.
  const verdict = obj(raw.verdict);
  if (verdict) out.verdict = clipFields(verdict, ['reason'], summaryBytes);
  const gate = obj(raw.gate);
  if (gate) out.gate = clipFields(gate, ['summary', 'proposed_action'], summaryBytes);
  const ws = obj(raw.workspace);
  if (ws) {
    // The DESCRIPTOR survives (baseline, patchSha256, patchBytes, diffstat, patchRefused, error);
    // only the bytes go. That descriptor is what makes the artifact fetch worth making.
    const { patch: _p, patchBase64: _b, ...kept } = ws;
    out.workspace = kept;
  }
  // At a cap of 0 the summary is OMITTED rather than clipped to the bare marker: 0 is how an
  // operator asks for no summary (docs/reference/configuration.md), and a `summary` key holding
  // nothing but `…[truncated]` is not that.
  const summary = summaryBytes > 0 ? summarize(raw, ws) : null;
  if (summary) out.summary = clip(summary, summaryBytes);
  const artifacts = describeArtifacts(raw, ws);
  if (artifacts.length > 0) out.artifacts = artifacts;
  return out;
}

/**
 * A copy of `src` with the named string fields clipped; anything else passes through untouched.
 *
 * At a cap of 0 the field is REMOVED rather than replaced by the bare `…[truncated]` marker, for the
 * same reason `summary` is omitted there: 0 is how an operator asks for no model prose in this body,
 * and a `reason` whose whole content is a truncation marker is not that.
 */
function clipFields(
  src: Record<string, unknown>,
  fields: readonly string[],
  maxBytes: number,
): Record<string, unknown> {
  const out = { ...src };
  for (const f of fields) {
    const s = str(out[f]);
    if (!s) continue;
    if (maxBytes > 0) out[f] = clip(s, maxBytes);
    else delete out[f];
  }
  return out;
}

/**
 * The one line a caller reads instead of the output: the prompt leaf's text, a gate's summary, a
 * patch's diffstat, or a failure's reason — whichever this result has, in that order. Clipped by
 * the caller, so a leaf that answered with a megabyte of prose costs a poll the same as a terse one.
 */
function summarize(
  raw: Record<string, unknown>,
  ws: Record<string, unknown> | null,
): string | null {
  const text = str(raw.text);
  if (text) return text;
  const gate = obj(raw.gate);
  const gateSummary = gate ? str(gate.summary) : null;
  if (gateSummary) return gateSummary;
  const stat = obj(ws?.diffstat);
  if (stat) {
    const n = (v: unknown) => (typeof v === 'number' ? v : 0);
    return `${n(stat.files)} files, +${n(stat.insertions)} -${n(stat.deletions)}`;
  }
  return str(raw.reason);
}

/**
 * `patch` when there are bytes to serve, nothing otherwise. A record whose capture was refused for
 * size (`patchRefused`) deliberately has no artifact: the worker never carried the bytes out of the
 * sandbox, so there is nothing to fetch and the descriptor is the whole answer.
 */
function describeArtifacts(
  raw: Record<string, unknown>,
  ws: Record<string, unknown> | null,
): TurnArtifact[] {
  const bytes = patchSize(raw, ws);
  if (bytes === null) return [];
  const sha = ws ? str(ws.patchSha256) : null;
  return [{ kind: 'patch', bytes, ...(sha ? { sha256: sha } : {}) }];
}

/**
 * The patch's size, without materialising it: the status read is POLLED, so it must not copy a
 * multi-megabyte diff per call the way `patchBody` does. A base64 capture states its decoded size
 * in the descriptor (`captureTurnPatch` measures the raw buffer); only a record without one pays
 * for the decode.
 */
function patchSize(
  raw: Record<string, unknown>,
  ws: Record<string, unknown> | null,
): number | null {
  const text = str(raw.patch) ?? (ws ? str(ws.patch) : null);
  if (text) return Buffer.byteLength(text, 'utf8');
  const b64 = ws ? str(ws.patchBase64) : null;
  if (!b64) return null;
  const declared = ws && typeof ws.patchBytes === 'number' ? ws.patchBytes : null;
  return declared ?? Buffer.from(b64, 'base64').byteLength;
}

/**
 * The artifact the path names, or null when this result has none. `kind` is validated here rather
 * than by the router: an unknown kind and a result without that kind are the same answer (404), so
 * there is one place that decides it.
 */
export function pickArtifact(raw: Record<string, unknown>, kind: string): ArtifactBody | null {
  if (kind !== 'patch') return null;
  return patchBody(raw, obj(raw.workspace));
}

/**
 * A solve leaf's patch lives in `patch` (the result IS the diff); a prompt leaf's in
 * `workspace.patch`, or `workspace.patchBase64` when the diff was not valid UTF-8 — which is why
 * this returns a Buffer and not a string.
 *
 * `patchSha256` covers whichever of the three the record has: `describePatch` hashes the same
 * string `runSolveLeaf` puts in `patch`, and `captureTurnPatch` hashes the raw buffer it then
 * stores as `patch` or `patchBase64`. So it is carried out as the digest OF THESE BYTES.
 */
function patchBody(
  raw: Record<string, unknown>,
  ws: Record<string, unknown> | null,
): ArtifactBody | null {
  const sha = ws ? str(ws.patchSha256) : null;
  const of = (bytes: Buffer): ArtifactBody => ({
    bytes,
    contentType: PATCH_CONTENT_TYPE,
    ...(sha ? { sha256: sha } : {}),
  });
  const text = str(raw.patch) ?? (ws ? str(ws.patch) : null);
  if (text) return of(Buffer.from(text, 'utf8'));
  const b64 = ws ? str(ws.patchBase64) : null;
  if (b64) return of(Buffer.from(b64, 'base64'));
  return null;
}
