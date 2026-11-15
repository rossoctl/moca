import { EventEmitter } from 'node:events';
import { status } from '@grpc/grpc-js';
import type { SandboxTokenClaims } from '@moca/control-plane';
import { Exec } from '@moca/k8s-sandbox';
import { describe, expect, it, vi } from 'vitest';
import type { Relay, RelayTimers } from '../src/relay.js';
import { makeAudit, makeSandboxCaller } from '../src/sandbox-caller.js';

// Review #554: building an audit line (not only writing it) must never skip enforcement. A claims
// object whose `sub` getter throws breaks every line's builder while leaving `sbx`, which the
// enforcement reads, intact.

/** Timers fired by hand, so the expiry and the drain grace run when the test says. */
function manualTimers() {
  const due: Array<{ fn: () => void; live: boolean }> = [];
  const timers: RelayTimers = {
    setTimeout: (fn) => {
      const t = { fn, live: true };
      due.push(t);
      return t;
    },
    clearTimeout: (h) => {
      if (h) (h as { live: boolean }).live = false;
    },
  };
  const fire = () => {
    for (const t of due.splice(0)) if (t.live) t.fn();
  };
  return { timers, fire };
}

/** A relay whose worker never answers: every routeExec waits until `finish`. */
function silentRelay() {
  const aborts: number[] = [];
  const waiting: Array<() => void> = [];
  const relay = {
    async *routeExec() {
      await new Promise<void>((r) => waiting.push(r));
    },
    routeAbort: (_s: string, id: number) => aborts.push(id),
  } as unknown as Relay;
  return { relay, aborts, finish: () => waiting.splice(0).forEach((f) => f()) };
}

function fakeCall() {
  const errors: Array<{ code?: number }> = [];
  const call = Object.assign(new EventEmitter(), {
    cancelled: false,
    write() {},
    end() {},
  });
  call.on('error', (e: { code?: number }) => errors.push(e));
  return { call, errors };
}

const brokenClaims = (): SandboxTokenClaims =>
  ({
    get sub(): string {
      throw new Error('claims getter blew up');
    },
    sbx: 'sbx-aaaa',
    wrk: 'sbx_default',
    wsk: 'sbx-aaaa',
    exp: 0, // already past: the expiry fires on the first timer
  }) as unknown as SandboxTokenClaims;

const exec = (reqId: number) =>
  Exec.fromPartial({ reqId, command: 'sleep 600', workspaceKey: 'sbx-aaaa', timeoutS: 600 });

describe('a throwing audit-line builder never skips enforcement (review #554)', () => {
  it('the expiry still aborts the worker and ends the call; the drain grace still frees the slot', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { timers, fire } = manualTimers();
      const r = silentRelay();
      const caller = makeSandboxCaller(r.relay, {
        maxInflight: 1,
        leewayS: 0,
        drainGraceS: 60,
        reqIdKey: Buffer.alloc(32, 7),
        timers,
        audit: makeAudit(() => {}, true),
      });
      const claims = brokenClaims();
      const first = fakeCall();
      const running = caller.exec(first.call as never, claims, 'sbx_default', exec(1), Date.now());
      fire(); // the token's exp + leeway: the expiry's line throws while it is built
      expect(r.aborts).toHaveLength(1);
      expect(first.errors.map((e) => e.code)).toEqual([status.DEADLINE_EXCEEDED]);
      // The worker never acknowledges: the drain grace (its `released` line throws too) frees it.
      fire();
      const second = fakeCall();
      void caller.exec(second.call as never, claims, 'sbx_default', exec(2), Date.now());
      await new Promise((res) => setImmediate(res));
      // With the cap at 1, a slot the release failed to free would refuse this one as busy.
      expect(second.errors.map((e) => e.code)).not.toContain(status.RESOURCE_EXHAUSTED);
      r.finish();
      await running;
      expect(quiet.mock.calls.join(' ')).toContain('audit line not written: claims getter blew up');
    } finally {
      quiet.mockRestore();
    }
  });

  it('an Exec that ends still frees its slot and ownership, and a refused Abort is still refused', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { timers } = manualTimers();
      const r = silentRelay();
      const caller = makeSandboxCaller(r.relay, {
        maxInflight: 1,
        leewayS: 0,
        drainGraceS: 60,
        reqIdKey: Buffer.alloc(32, 7),
        timers,
        audit: makeAudit(() => {}, true),
      });
      const claims = brokenClaims();
      const first = fakeCall();
      const running = caller.exec(first.call as never, claims, 'sbx_default', exec(1), Date.now());
      await new Promise((res) => setImmediate(res));
      r.finish(); // the stream ends; the final line's builder throws in the `finally`
      await expect(running).resolves.toBeUndefined();
      // Ownership was given back: an Abort of it is refused (its line throws as it is built).
      const refused = caller.abort(claims, 'sbx_default', 1);
      expect(refused).toHaveProperty('refusal');
      // And the slot: the cap of 1 admits the next Exec.
      const second = fakeCall();
      void caller.exec(second.call as never, claims, 'sbx_default', exec(2), Date.now());
      await new Promise((res) => setImmediate(res));
      expect(second.errors.map((e) => e.code)).not.toContain(status.RESOURCE_EXHAUSTED);
      r.finish();
    } finally {
      quiet.mockRestore();
    }
  });
});
