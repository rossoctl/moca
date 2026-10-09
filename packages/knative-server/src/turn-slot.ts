import type { ServerResponse } from 'node:http';

/**
 * A P6 worker counts a turn from its request until its response closes (worker.ts). A detachable
 * turn outlives its response (turn-reattach spec §5.5), so the route ADOPTS the slot: the response's
 * close no longer ends it, and the route ends it when the turn itself ends. Outside a worker there
 * is no slot, and adopting returns a no-op.
 */
const SLOT = Symbol.for('moca.turnSlot');
interface Slot {
  end: () => void;
  adopted: boolean;
}

export function attachTurnSlot(res: ServerResponse, end: () => void): void {
  const slot: Slot = { end, adopted: false };
  (res as unknown as Record<symbol, Slot>)[SLOT] = slot;
  res.on('close', () => {
    if (!slot.adopted) end();
  });
}

export function adoptTurnSlot(res: ServerResponse): () => void {
  const slot = (res as unknown as Record<symbol, Slot | undefined>)[SLOT];
  if (!slot) return () => {};
  slot.adopted = true;
  return slot.end;
}
