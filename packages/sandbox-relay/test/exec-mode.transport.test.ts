import { status } from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxMode } from '@moca/k8s-sandbox';
import { SANDBOX_TOKEN_TYP, type SandboxTokenClaims } from '@moca/control-plane';
import { claimsToExecMode } from '../src/sandbox-caller.js';
import {
  HARNESS,
  K,
  claims,
  closeAll,
  exec,
  idsOf,
  relay,
  token,
  wid,
  worker,
} from './helpers/sandbox-relay.js';

// Lease-mode spec §8.2: on the sandbox-token path the relay is the only setter of an Exec's mode
// fields. Whatever a client writes into Exec.mode, mode_epoch or idle_timeout_s is overwritten
// from the verified claims, so a per-exec token can never raise its own lease mode; keepalive is
// the client's opt-in and passes through. The harness never uses leases: its Execs go out with all
// four zeroed. A worker's lease event reaches the caller on the Exec it names, under the caller's
// own req_id.

afterEach(closeAll);

/** What a client that tries to pick its own lease writes into its Exec. */
const FORGED = {
  mode: SandboxMode.SANDBOX_MODE_LEASE,
  modeEpoch: 999,
  idleTimeoutS: 5,
};
const modeOf = (e: { mode: number; modeEpoch: number; idleTimeoutS: number }) => ({
  mode: e.mode,
  modeEpoch: e.modeEpoch,
  idleTimeoutS: e.idleTimeoutS,
});

describe('claimsToExecMode', () => {
  const c = (over: Partial<SandboxTokenClaims>) =>
    ({ mode: 'per-exec', mode_epoch: 0, idle_timeout_s: 0, ...over }) as SandboxTokenClaims;
  it.each([
    ['per-exec', SandboxMode.SANDBOX_MODE_PER_EXEC],
    ['lease', SandboxMode.SANDBOX_MODE_LEASE],
    ['lease+processes', SandboxMode.SANDBOX_MODE_LEASE_PROCESSES],
  ] as const)('maps the %s claim to its proto enum', (mode, want) => {
    expect(claimsToExecMode(c({ mode, mode_epoch: 4, idle_timeout_s: 600 }))).toEqual({
      mode: want,
      modeEpoch: 4,
      idleTimeoutS: 600,
    });
  });
});

describe('the relay sets Exec mode fields from the token (lease-mode §8.2)', () => {
  it('relay overwrites client mode fields from claims', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default');
    const perExec = await exec(r.exec, { token: token(), reqId: 1, fields: FORGED }).done;
    expect(perExec.code).toBe(status.OK);
    const lease = await exec(r.exec, {
      token: token({ mode: 'lease', modeEpoch: 3, idleTimeoutS: 600 }),
      reqId: 2,
      fields: { ...FORGED, mode: SandboxMode.SANDBOX_MODE_LEASE_PROCESSES },
    }).done;
    expect(lease.code).toBe(status.OK);
    expect(w.execs.map(modeOf)).toEqual([
      { mode: SandboxMode.SANDBOX_MODE_PER_EXEC, modeEpoch: 0, idleTimeoutS: 0 },
      { mode: SandboxMode.SANDBOX_MODE_LEASE, modeEpoch: 3, idleTimeoutS: 600 },
    ]);
  });

  it('keepalive passes through', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default');
    const t = token({ mode: 'lease', modeEpoch: 1 });
    expect(
      (await exec(r.exec, { token: t, reqId: 1, fields: { keepalive: true } }).done).code,
    ).toBe(status.OK);
    expect((await exec(r.exec, { token: t, reqId: 2 }).done).code).toBe(status.OK);
    expect(w.execs.map((e) => e.keepalive)).toEqual([true, false]);
  });

  it('harness path zeroes mode fields', async () => {
    const r = await relay({ MOCA_RELAY_EXEC_TOKEN: HARNESS });
    const w = await worker(r.attach, 'sbx_default');
    const res = await exec(r.exec, {
      token: HARNESS,
      reqId: 900,
      wsk: 'run-1',
      fields: { ...FORGED, keepalive: true },
    }).done;
    expect(res.code).toBe(status.OK);
    expect(w.execs.map((e) => ({ ...modeOf(e), keepalive: e.keepalive }))).toEqual([
      {
        mode: SandboxMode.SANDBOX_MODE_UNSPECIFIED,
        modeEpoch: 0,
        idleTimeoutS: 0,
        keepalive: false,
      },
    ]);
  });

  it('an old token without mode claims routes per-exec epoch 0', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default');
    const old = claims();
    expect(old).not.toHaveProperty('mode');
    const t = K.signer.signJws(SANDBOX_TOKEN_TYP, old);
    const res = await exec(r.exec, { token: t, reqId: 1, fields: FORGED }).done;
    expect(res.code).toBe(status.OK);
    expect(w.execs.map(modeOf)).toEqual([
      { mode: SandboxMode.SANDBOX_MODE_PER_EXEC, modeEpoch: 0, idleTimeoutS: 0 },
    ]);
  });
});

describe('lease events reach the caller (lease-mode §4)', () => {
  it('lease event reaches the sandbox caller with its own req_id', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'auto', 0, () => [
      {
        lease: {
          state: 'start',
          atUnixMs: 1_700_000_000_123,
          mode: SandboxMode.SANDBOX_MODE_LEASE,
          ageMs: 0,
        },
      },
      { chunk: { data: 'hi' } },
      { end: { exitCode: 0 } },
    ]);
    const res = await exec(r.exec, {
      token: token({ mode: 'lease', modeEpoch: 2 }),
      reqId: 7,
    }).done;
    expect(res.code).toBe(status.OK);
    // The worker saw the relay's id; the caller sees only its own, on every frame.
    expect(w.execs.map((e) => e.reqId)).toEqual([wid('sbx-aaaa', 7)]);
    expect(idsOf(res.events)).toEqual([7, 7, 7]);
    expect(res.events[0]!.lease).toEqual({
      reqId: 7,
      state: 'start',
      reason: '',
      atUnixMs: 1_700_000_000_123,
      mode: SandboxMode.SANDBOX_MODE_LEASE,
      ageMs: 0,
      processes: [],
      endsByUnixMs: 0,
    });
    const kinds = res.events.map((ev) => Object.entries(ev).flatMap(([k, v]) => (v ? [k] : [])));
    expect(kinds).toEqual([['lease'], ['chunk'], ['end']]);
  });
});
