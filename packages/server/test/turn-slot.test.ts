import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { adoptTurnSlot, attachTurnSlot } from '../src/turn-slot.js';

/** A ServerResponse stand-in: the slot contract needs 'close' emission and a `destroyed` flag. */
const fakeRes = (destroyed = false): ServerResponse =>
  Object.assign(new EventEmitter(), { destroyed }) as unknown as ServerResponse;

describe('turn slot with multiple ends', () => {
  it('fires every attached end, once, when the response closes', () => {
    const res = fakeRes();
    const turnEnd = vi.fn();
    const subjectEnd = vi.fn();
    attachTurnSlot(res, turnEnd); // the worker's count, before the route runs
    attachTurnSlot(res, subjectEnd); // the route's own count, once it knows the subject (#360)
    res.emit('close');
    expect(turnEnd).toHaveBeenCalledTimes(1);
    expect(subjectEnd).toHaveBeenCalledTimes(1);
    res.emit('close'); // ends are idempotent by construction; a second close must not re-run them
    expect(turnEnd).toHaveBeenCalledTimes(1);
    expect(subjectEnd).toHaveBeenCalledTimes(1);
  });

  it('adoption defers every end to the adopted release, past the close', () => {
    const res = fakeRes();
    const turnEnd = vi.fn();
    const subjectEnd = vi.fn();
    attachTurnSlot(res, turnEnd);
    attachTurnSlot(res, subjectEnd);
    const release = adoptTurnSlot(res);
    res.emit('close');
    expect(turnEnd).not.toHaveBeenCalled();
    expect(subjectEnd).not.toHaveBeenCalled();
    release();
    expect(turnEnd).toHaveBeenCalledTimes(1);
    expect(subjectEnd).toHaveBeenCalledTimes(1);
  });

  it('a slot attached outside a worker still rides close (the standalone tier)', () => {
    const res = fakeRes();
    const subjectEnd = vi.fn();
    attachTurnSlot(res, subjectEnd);
    res.emit('close');
    expect(subjectEnd).toHaveBeenCalledTimes(1);
  });

  it('a slot attached outside a worker is still adopted by a detachable turn', () => {
    // Without this, a detachable turn on the standalone tier would release the subject's slot at
    // response close while the turn itself runs on — the very leak the adoption mechanism exists
    // to prevent, reached by the second end.
    const res = fakeRes();
    const subjectEnd = vi.fn();
    attachTurnSlot(res, subjectEnd);
    const release = adoptTurnSlot(res);
    res.emit('close');
    expect(subjectEnd).not.toHaveBeenCalled();
    release();
    expect(subjectEnd).toHaveBeenCalledTimes(1);
  });

  it('adoptTurnSlot on a response that never had a slot is a no-op', () => {
    const res = fakeRes();
    const release = adoptTurnSlot(res);
    expect(() => release()).not.toThrow();
  });

  it('attaching after the response closed runs the end at once — a late end must not be dropped', async () => {
    // Review round 1's blocking finding, worker half: the worker's slot ends when the client
    // leaves during the credential exchange; the route's subject end is attached AFTER that, and
    // a push onto an ended slot's list would never run — a leaked subject slot until restart.
    const res = fakeRes();
    const workerEnd = vi.fn();
    attachTurnSlot(res, workerEnd); // the worker's count, before the route runs
    res.emit('close'); // the client leaves while resolveTurnAuth awaits the exchange
    const lateEnd = vi.fn();
    attachTurnSlot(res, lateEnd); // the route's subject end, after the await
    expect(workerEnd).toHaveBeenCalledTimes(1);
    expect(lateEnd).toHaveBeenCalledTimes(1);
  });

  it('attaching to a destroyed, unadopted response runs the end at once', async () => {
    // The standalone half of the same finding: no slot existed, so 'close' (already fired, or
    // firing on the destroy) can never run a listener registered now. `res.destroyed` is the
    // only reliable signal left.
    const res = fakeRes(true);
    const end = vi.fn();
    attachTurnSlot(res, end);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('attaching to a destroyed but ADOPTED slot still defers to the adopted release', async () => {
    // A detachable turn outlives its (closed, destroyed) response; an end attached to its slot
    // belongs to the turn's end, not the response's.
    const res = fakeRes();
    attachTurnSlot(res, vi.fn()); // creates the slot, as the worker does
    const release = adoptTurnSlot(res);
    (res as unknown as { destroyed: boolean }).destroyed = true;
    const lateEnd = vi.fn();
    attachTurnSlot(res, lateEnd);
    expect(lateEnd).not.toHaveBeenCalled();
    release();
    expect(lateEnd).toHaveBeenCalledTimes(1);
  });
});
