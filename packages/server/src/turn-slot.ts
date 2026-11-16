import type { ServerResponse } from 'node:http';

/**
 * A P6 worker counts a turn from its request until its response closes (worker.ts). A detachable
 * turn outlives its response (turn-reattach spec §5.5), so the route ADOPTS the slot: the response's
 * close no longer ends it, and the route ends it when the turn itself ends. Outside a worker there
 * is no slot, and adopting returns a no-op.
 *
 * A slot holds any number of ends — the worker's turn count, and the per-subject quota's slot
 * (#360) — so every count that means "this turn occupies something" shares ONE lifecycle: released
 * on response close, or on adoption for a detachable turn. Each end must be idempotent on its own
 * (TurnCounter's and SubjectCounter's both are); the slot guards `ended` regardless, so a second
 * close or a release after close cannot re-run them.
 */
const SLOT = Symbol.for('moca.turnSlot');
interface Slot {
  ends: Array<() => void>;
  adopted: boolean;
  ended: boolean;
  /** Runs every attached end, once. */
  end: () => void;
}

const slotOf = (res: ServerResponse): Slot | undefined =>
  (res as unknown as Record<symbol, Slot | undefined>)[SLOT];

function ensureSlot(res: ServerResponse): Slot {
  const existing = slotOf(res);
  if (existing) return existing;
  const slot: Slot = { ends: [], adopted: false, ended: false, end: () => {} };
  // Assigned after creation: `end` closes over `slot` itself.
  slot.end = () => {
    if (slot.ended) return;
    slot.ended = true;
    for (const e of slot.ends) e();
  };
  (res as unknown as Record<symbol, Slot>)[SLOT] = slot;
  res.on('close', () => {
    if (!slot.adopted) slot.end();
  });
  return slot;
}

/**
 * Attach one more end to this response's turn lifecycle. The worker calls this for its turn
 * count before the route runs; a route that counts something else per turn (the per-subject
 * quota, #360) calls it again once it knows the subject. With no slot yet — a route that runs
 * outside a worker, or the standalone tier — one is created, so a later adoption defers this end
 * too, rather than letting it fire at response close while the turn itself runs on.
 *
 * A LATE attach — after the slot ended, or onto a response already destroyed without adoption —
 * runs `end` at once instead of pushing it onto a list nothing will ever run again. Both halves
 * of that are real, not defensive: a client can leave while `resolveTurnAuth` awaits the
 * control-plane exchange, and the route's own end is attached only after that await — the
 * worker's slot has already ended by then (or, with no slot, the response's 'close' has already
 * fired and a listener registered now never will), so without this the subject's count would
 * stay up for the life of the process. An ADOPTED slot is the exception: its turn outlives the
 * destroyed response, so a late end still belongs to the adopted release.
 */
export function attachTurnSlot(res: ServerResponse, end: () => void): void {
  const slot = ensureSlot(res);
  if (slot.ended || (res.destroyed && !slot.adopted)) {
    end();
    return;
  }
  slot.ends.push(end);
}

export function adoptTurnSlot(res: ServerResponse): () => void {
  const slot = slotOf(res);
  if (!slot) return () => {};
  slot.adopted = true;
  return slot.end;
}
