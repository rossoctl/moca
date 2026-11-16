import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProcessOutcome } from '@moca/harness/leaf-job-runner';
import {
  asyncLeafCap,
  createLeafDrainLoop,
  shouldArmAsync,
  type LeafDrainLoopDeps,
} from '../src/leaf-drain-loop.js';
import { TurnCounter } from '../src/worker.js';

/**
 * A processOne stand-in. Each call resolves to the next scripted outcome. Typed against the
 * domain type -- not a widened `{ kind: string } & Record<string, unknown>` -- so a fixture with
 * an impossible `status` or a misspelled field (e.g. `reclaimedd`) fails tsc instead of silently
 * typechecking and passing.
 */
function scripted(outcomes: Array<ProcessOutcome | Error>, onCall?: () => void) {
  let i = 0;
  return vi.fn(async () => {
    onCall?.();
    const next = outcomes[Math.min(i++, outcomes.length - 1)]!;
    if (next instanceof Error) throw next;
    return next as never;
  });
}

function loopDeps(over: Partial<LeafDrainLoopDeps> = {}): LeafDrainLoopDeps {
  return {
    job: {} as never,
    counter: new TurnCounter(() => {}),
    cap: 2,
    processOneImpl: scripted([{ kind: 'idle' }]),
    sleep: async () => {},
    log: () => {},
    ...over,
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('shouldArmAsync', () => {
  const full = {
    SH_ASYNC_DRAIN: '1',
    SH_CONTROL_PLANE_URL: 'http://cp',
    SH_EXCHANGE_TOKEN: 'tok',
  };
  it('arms when the knob and both control-plane settings are present', () => {
    expect(shouldArmAsync(full)).toBe(true);
  });
  it('is off by default', () => {
    expect(shouldArmAsync({})).toBe(false);
  });
  it.each(['0', 'false', ''])('treats SH_ASYNC_DRAIN=%o as off', (v) => {
    expect(shouldArmAsync({ ...full, SH_ASYNC_DRAIN: v })).toBe(false);
  });
  it.each(['SH_CONTROL_PLANE_URL', 'SH_EXCHANGE_TOKEN'])('refuses to arm without %s', (missing) => {
    const env: Record<string, string> = { ...full };
    delete env[missing];
    expect(shouldArmAsync(env)).toBe(false);
  });
  it('refuses to arm under multi tenancy, which answers 501', () => {
    expect(shouldArmAsync({ ...full, MOCA_TENANCY: 'multi' })).toBe(false);
  });
  it('names the missing setting in the log when the knob is on', () => {
    const log = vi.fn();
    shouldArmAsync({ SH_ASYNC_DRAIN: '1' }, log);
    expect(log.mock.calls.flat().join(' ')).toContain('SH_CONTROL_PLANE_URL');
  });
  it('says nothing when the knob is off', () => {
    const log = vi.fn();
    shouldArmAsync({}, log);
    expect(log).not.toHaveBeenCalled();
  });

  // deploy/vm sets the token as a systemd credential, NOT an env line -- and
  // supervisor.env.example:65 says setting it as an env var instead makes the workers refuse to
  // boot. Reading env.SH_EXCHANGE_TOKEN directly would therefore pass every test above and never
  // arm on the one deployment this slice targets.
  it('resolves the token from a systemd credential when the unit loads one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'async-cred-'));
    writeFileSync(join(dir, 'SH_EXCHANGE_TOKEN'), 'from-credential\n');
    expect(
      shouldArmAsync({
        SH_ASYNC_DRAIN: '1',
        SH_CONTROL_PLANE_URL: 'http://cp',
        CREDENTIALS_DIRECTORY: dir,
      }),
    ).toBe(true);
  });
});

describe('asyncLeafCap', () => {
  it('reads SH_TURNS_PER_WORKER', () => {
    expect(asyncLeafCap({ SH_TURNS_PER_WORKER: '4' })).toBe(4);
  });
  it.each(['', '0', '-1', 'two', '1.5', ' '])('falls back on %o', (v) => {
    expect(asyncLeafCap({ SH_TURNS_PER_WORKER: v }, 3)).toBe(3);
  });
  it('falls back when unset', () => {
    expect(asyncLeafCap({}, 3)).toBe(3);
  });
});

describe('createLeafDrainLoop', () => {
  it('takes a slot before processOne runs, and releases it after', async () => {
    const counter = new TurnCounter(() => {});
    const seen: number[] = [];
    const processOneImpl = scripted([{ kind: 'idle' }], () => seen.push(counter.inFlight));
    const loop = createLeafDrainLoop(loopDeps({ counter, processOneImpl }));
    loop.start();
    await tick();
    await loop.stop();
    expect(seen[0]).toBe(1); // held DURING the claim, not after it
    expect(counter.inFlight).toBe(0);
  });

  it('does not claim while the worker is at its cap', async () => {
    const counter = new TurnCounter(() => {});
    const held = [counter.start(), counter.start()];
    const processOneImpl = scripted([{ kind: 'idle' }]);
    const sleep = vi.fn(async () => {});
    const loop = createLeafDrainLoop(loopDeps({ counter, cap: 2, processOneImpl, sleep }));
    loop.start();
    await tick();
    expect(processOneImpl).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalled();
    held.forEach((end) => end());
    await loop.stop();
  });

  it('reports every claim it did not attempt because the worker was full', async () => {
    const counter = new TurnCounter(() => {});
    const held = counter.start();
    const onCapDenied = vi.fn();
    const loop = createLeafDrainLoop(
      loopDeps({ counter, cap: 1, onCapDenied, processOneImpl: scripted([{ kind: 'idle' }]) }),
    );
    loop.start();
    await tick();
    expect(onCapDenied).toHaveBeenCalled();
    held();
    await loop.stop();
  });

  it('does not report a cap denial when it did claim', async () => {
    const onCapDenied = vi.fn();
    const loop = createLeafDrainLoop(
      loopDeps({ onCapDenied, processOneImpl: scripted([{ kind: 'idle' }]) }),
    );
    loop.start();
    await tick();
    await loop.stop();
    expect(onCapDenied).not.toHaveBeenCalled();
  });

  it('claims again once a sync turn frees a slot', async () => {
    const counter = new TurnCounter(() => {});
    const end = counter.start();
    const processOneImpl = scripted([{ kind: 'idle' }]);
    const loop = createLeafDrainLoop(loopDeps({ counter, cap: 1, processOneImpl }));
    loop.start();
    await tick();
    expect(processOneImpl).not.toHaveBeenCalled();
    end();
    await tick();
    expect(processOneImpl).toHaveBeenCalled();
    await loop.stop();
  });

  it('reports every outcome to onOutcome', async () => {
    const onOutcome = vi.fn();
    const processOneImpl = scripted([
      { kind: 'completed', turnId: 't1', status: 'done', reclaimed: false },
      { kind: 'idle' },
    ]);
    const loop = createLeafDrainLoop(loopDeps({ processOneImpl, onOutcome }));
    loop.start();
    await tick();
    await tick();
    await loop.stop();
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'completed', turnId: 't1' }),
    );
  });

  // The claim is non-blocking, so the idle wait is the loop's own sleep -- and it must happen with
  // NO slot held. Sleeping inside the slot is what made an armed-but-idle worker report inFlight
  // >= 1 essentially always, which 429'd interactive /turn traffic against an empty queue.
  it('waits out an idle claim with the admission slot RELEASED', async () => {
    const counter = new TurnCounter(() => {});
    const duringSleep: number[] = [];
    const sleep = vi.fn(async () => {
      duringSleep.push(counter.inFlight);
    });
    const loop = createLeafDrainLoop(
      loopDeps({ counter, processOneImpl: scripted([{ kind: 'idle' }]), sleep }),
    );
    loop.start();
    await tick();
    await loop.stop();
    expect(sleep).toHaveBeenCalledWith(expect.any(Number));
    expect(duringSleep[0]).toBe(0);
  });

  it('waits out a thrown claim with the slot released too', async () => {
    const counter = new TurnCounter(() => {});
    const duringSleep: number[] = [];
    const sleep = vi.fn(async () => {
      duringSleep.push(counter.inFlight);
    });
    const loop = createLeafDrainLoop(
      loopDeps({ counter, processOneImpl: scripted([new Error('boom')]), sleep }),
    );
    loop.start();
    await tick();
    await loop.stop();
    expect(duringSleep[0]).toBe(0);
  });

  it('survives a thrown processOne, backs off, and keeps looping', async () => {
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const processOneImpl = scripted([new Error('control plane unreachable'), { kind: 'idle' }]);
    const loop = createLeafDrainLoop(loopDeps({ processOneImpl, sleep, log }));
    loop.start();
    await tick();
    await tick();
    await loop.stop();
    expect(sleep).toHaveBeenCalledWith(expect.any(Number));
    expect(processOneImpl.mock.calls.length).toBeGreaterThan(1);
    expect(log.mock.calls.flat().join(' ')).toContain('control plane unreachable');
  });

  it('releases the slot even when processOne throws', async () => {
    const counter = new TurnCounter(() => {});
    const loop = createLeafDrainLoop(
      loopDeps({ counter, processOneImpl: scripted([new Error('boom')]) }),
    );
    loop.start();
    await tick();
    await loop.stop();
    expect(counter.inFlight).toBe(0);
  });

  it('stop() returns without waiting for the in-flight leaf', async () => {
    let finish!: () => void;
    const processOneImpl = vi.fn(
      () => new Promise((r) => (finish = () => r({ kind: 'idle' } as never))),
    ) as never;
    const loop = createLeafDrainLoop(loopDeps({ processOneImpl }));
    loop.start();
    await tick();
    await loop.stop(); // must not hang on the pending leaf
    expect(loop.running).toBe(false);
    finish();
  });

  it('stop() releases the in-flight slot so awaitIdle can exit early', async () => {
    const counter = new TurnCounter(() => {});
    const processOneImpl = vi.fn(() => new Promise(() => {})) as never; // never settles
    const loop = createLeafDrainLoop(loopDeps({ counter, processOneImpl }));
    loop.start();
    await tick();
    expect(counter.inFlight).toBe(1);
    await loop.stop();
    expect(counter.inFlight).toBe(0);
  });

  it('never deletes its consumer on stop: that would discard the pending entry', async () => {
    const deleteConsumer = vi.fn();
    const loop = createLeafDrainLoop(
      loopDeps({ job: { queue: { deleteConsumer } } as never, processOneImpl: scripted([]) }),
    );
    loop.start();
    await tick();
    await loop.stop();
    expect(deleteConsumer).not.toHaveBeenCalled();
  });

  it('claims nothing more after stop()', async () => {
    const processOneImpl = scripted([{ kind: 'idle' }]);
    const loop = createLeafDrainLoop(loopDeps({ processOneImpl }));
    loop.start();
    await tick();
    await loop.stop();
    const after = processOneImpl.mock.calls.length;
    await tick();
    await tick();
    expect(processOneImpl.mock.calls.length).toBe(after);
  });

  it('is safe to stop twice and to start twice', async () => {
    const processOneImpl = scripted([{ kind: 'idle' }]);
    const loop = createLeafDrainLoop(loopDeps({ processOneImpl }));
    loop.start();
    loop.start(); // second start must not run a second loop
    await tick();
    await loop.stop();
    await loop.stop();
    expect(loop.running).toBe(false);
  });

  // §5.3's whole point: the cap check and counter.start() must be ONE synchronous tick. The test
  // above ("takes a slot before processOne runs") checks the slot is held DURING the claim, which
  // still passes even if an `await` were inserted between the check and the take -- it does not
  // discriminate. This one does: with cap: 1 and a leaf that never settles, counter.inFlight must
  // already read 1 the instant loop.start() returns, with NO await in this test in between. An
  // `await Promise.resolve()` inserted between the check and counter.start() in the
  // implementation makes this fail with "expected +0 to be 1".
  it('takes the slot in the SAME synchronous tick as the cap check', async () => {
    const counter = new TurnCounter(() => {});
    const processOneImpl = vi.fn(() => new Promise(() => {})) as never; // never settles
    const loop = createLeafDrainLoop(loopDeps({ counter, cap: 1, processOneImpl }));
    loop.start();
    // No await here, on purpose -- see comment above.
    expect(counter.inFlight).toBe(1);
    await loop.stop();
  });

  it('survives a throwing onCapDenied and resumes once a slot frees', async () => {
    const counter = new TurnCounter(() => {});
    const held = counter.start();
    const onCapDenied = vi.fn(() => {
      throw new Error('metrics sink closed');
    });
    const log = vi.fn();
    const sleep = vi.fn(async () => {});
    const processOneImpl = scripted([{ kind: 'idle' }]);
    const loop = createLeafDrainLoop(
      loopDeps({ counter, cap: 1, onCapDenied, log, sleep, processOneImpl }),
    );
    loop.start();
    await tick();
    await tick();
    expect(onCapDenied).toHaveBeenCalled();
    expect(processOneImpl).not.toHaveBeenCalled();
    expect(loop.running).toBe(true); // a monitoring callback's bug must not kill the loop
    held(); // a sync /turn finishes and frees the only slot
    await tick();
    await tick();
    expect(processOneImpl).toHaveBeenCalled();
    await loop.stop();
  });

  it('does not let a rejection escape run() as an unhandled rejection, and marks itself stopped', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const counter = new TurnCounter(() => {});
      const held = counter.start();
      // onCapDenied throws, is caught, and the catch's own backoff sleep ALSO rejects -- the
      // double failure the per-iteration catch cannot absorb, so it must propagate out of run()
      // and land on the start()-time .catch() fallback instead of taking the process down.
      const onCapDenied = vi.fn(() => {
        throw new Error('metrics sink closed');
      });
      const sleep = vi.fn(async () => {
        throw new Error('backoff timer unavailable');
      });
      const loop = createLeafDrainLoop(
        loopDeps({
          counter,
          cap: 1,
          onCapDenied,
          sleep,
          processOneImpl: scripted([{ kind: 'idle' }]),
        }),
      );
      loop.start();
      await tick();
      await tick();
      expect(loop.running).toBe(false);
      held();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });
});
