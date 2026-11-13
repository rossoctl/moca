import { randomUUID } from 'node:crypto';
import { Metadata, credentials, status } from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LeaseOp,
  LeaseStatus,
  SandboxExecClient,
  SandboxMode,
  type Exec,
  type ExecEvent,
  type LeaseControlResponse,
} from '@moca/k8s-sandbox';
import {
  MemorySandboxStore,
  SANDBOX_HANDLERS,
  sandboxConfigFromEnv,
  type CpDeps,
  type SandboxModeName,
  type TokenClaims,
} from '@moca/control-plane';
import {
  ISS,
  K,
  closeAll,
  exec,
  reasons,
  relay,
  worker,
  type LeaseReply,
  type Reply,
} from './helpers/sandbox-relay.js';

// Plan 3's wire across components (lease-mode spec §8): the control plane's own sandbox handlers
// create the sandbox, change its mode and mint both tokens, as its routes do; the relay verifies
// them and fills in the frames; a fake worker records what reached it. No token here is minted by
// the test: every one comes out of a handler, from the sandbox record.

afterEach(closeAll);

const OWNER = {
  sub: 'github:1',
  tenant: 'github:1',
  roles: [],
  scope: ['api'],
} as unknown as TokenClaims;

interface SandboxBody {
  id: string;
  mode: SandboxModeName;
  idleTimeoutS: number;
  modeEpoch: number;
}

/**
 * A sandbox-profile control plane in-process: its config from the env it boots from, a memory
 * store, and the relay kit's signing key, so the relay verifies what it mints. The router's job
 * (authenticating OWNER's API token) is the one part left out.
 */
function controlPlane() {
  const audits: Array<Record<string, unknown>> = [];
  const deps = {
    config: {
      routeProfile: 'sandbox',
      sandbox: sandboxConfigFromEnv({
        SH_ALLOWED_SUBJECTS: OWNER.sub,
        SH_SANDBOX_EXEC_ENDPOINT: 'sbx-exec.example.invalid:443',
        SH_SANDBOX_TEMPLATES: JSON.stringify([
          { id: 'default', worker: 'sbx_default', description: 'bash', tools: ['bash'] },
        ]),
        SH_SANDBOX_TOKEN_ISSUER: ISS,
      }),
    },
    sandboxes: new MemorySandboxStore(),
    signer: K.signer,
    index: { audit: async () => {} },
    log: (l: Record<string, unknown>) => audits.push(l),
    now: () => Date.now(),
    newId: () => randomUUID(),
  } as unknown as CpDeps;
  const call = async (op: string, id?: string, body?: unknown): Promise<unknown> =>
    (
      await SANDBOX_HANDLERS[op]!(
        { params: id ? { id } : {}, query: new URLSearchParams(), body, principal: OWNER },
        deps,
      )
    ).body;
  return {
    audits,
    create: (body: Record<string, unknown>) =>
      call('createSandbox', undefined, { template: 'default', ...body }) as Promise<SandboxBody>,
    get: (id: string) => call('getSandbox', id) as Promise<SandboxBody>,
    token: (id: string) =>
      call('mintSandboxToken', id) as Promise<{ token: string; wrk: string; wsk: string }>,
    setMode: (id: string, body: Record<string, unknown>) =>
      call('setSandboxMode', id, body) as Promise<{ sandbox: SandboxBody; setModeToken: string }>,
    modeToken: (id: string) =>
      call('mintSandboxModeToken', id) as Promise<{ setModeToken: string }>,
  };
}

/**
 * A worker that keeps the highest epoch a set_mode gave each workspace and refuses an Exec below
 * it with `stale_mode`, as the Go worker does (spec §8.2); a lease Exec's response carries a lease
 * event before its End. Every frame is still recorded by the kit.
 */
function epochWorker(addr: string) {
  const stored = new Map<string, number>();
  const reply = (e: Exec): Reply => {
    const at = stored.get(e.workspaceKey) ?? 0;
    if (e.modeEpoch < at) {
      return [{ error: { message: `stale_mode: epoch ${e.modeEpoch} is below ${at}` } }];
    }
    const lease =
      e.mode === SandboxMode.SANDBOX_MODE_LEASE
        ? [{ lease: { state: 'start', atUnixMs: 1_700_000_000_123, mode: e.mode } }]
        : [];
    return [...lease, { chunk: { data: 'ok' } }, { end: { exitCode: 0 } }];
  };
  const lease: LeaseReply = (f) => {
    if (f.op === LeaseOp.LEASE_OP_SET_MODE) {
      stored.set(f.workspaceKey, Math.max(stored.get(f.workspaceKey) ?? 0, f.modeEpoch));
    }
    // A downgrade ends the lease; its mode_change end is reported in the result (ruling R16).
    const pending =
      f.mode === SandboxMode.SANDBOX_MODE_PER_EXEC
        ? { state: 'end', reason: 'mode_change', atUnixMs: 1_700_000_000_456 }
        : undefined;
    return {
      status: LeaseStatus.fromPartial({
        mode: f.mode,
        epochKnown: true,
        state: 'none',
        ...(pending ? { pending } : {}),
      }),
    };
  };
  return worker(addr, 'sbx_default', 'auto', 0, reply, undefined, lease);
}

function leaseControl(
  addr: string,
  t: string,
  sandboxId: string,
  op: LeaseOp,
  setModeToken = '',
): Promise<{ code: number; details: string; res?: LeaseControlResponse }> {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const md = new Metadata();
  md.set('authorization', `Bearer ${t}`);
  return new Promise<{ code: number; details: string; res?: LeaseControlResponse }>((resolve) =>
    client.leaseControl({ sandboxId, op, setModeToken }, md, (err, res) =>
      resolve(
        err ? { code: err.code, details: err.details } : { code: status.OK, details: '', res },
      ),
    ),
  ).finally(() => client.close());
}

const modeOf = (e: Exec) => ({
  workspaceKey: e.workspaceKey,
  mode: e.mode,
  modeEpoch: e.modeEpoch,
  idleTimeoutS: e.idleTimeoutS,
  keepalive: e.keepalive,
});
const kindsOf = (events: ExecEvent[]) =>
  events.map((ev) => Object.entries(ev).flatMap(([k, v]) => (v ? [k] : [])));

describe('the lease wire, control plane to worker (lease-mode §8)', () => {
  it("a lease create's token reaches the worker's Exec as its mode, epoch 1 and idle timeout", async () => {
    const cp = controlPlane();
    const r = await relay();
    const w = await epochWorker(r.attach);
    const sbx = await cp.create({ mode: 'lease', idleTimeoutS: 600 });
    expect(sbx).toMatchObject({ mode: 'lease', idleTimeoutS: 600, modeEpoch: 1 });
    const t = await cp.token(sbx.id);
    // The client writes per-exec, epoch 0 into its Exec; only keepalive is its own to set.
    const res = await exec(r.exec, {
      token: t.token,
      sandboxId: t.wrk,
      wsk: t.wsk,
      fields: { mode: SandboxMode.SANDBOX_MODE_PER_EXEC, modeEpoch: 0, keepalive: true },
    }).done;
    expect(res.code).toBe(status.OK);
    expect(w.execs.map(modeOf)).toEqual([
      {
        workspaceKey: sbx.id,
        mode: SandboxMode.SANDBOX_MODE_LEASE,
        modeEpoch: 1,
        idleTimeoutS: 600,
        keepalive: true,
      },
    ]);
    // The lease event rides on the response, before its End.
    expect(kindsOf(res.events)).toEqual([['lease'], ['chunk'], ['end']]);
    expect(res.events[0]!.lease).toMatchObject({ state: 'start', atUnixMs: 1_700_000_000_123 });
  });

  it('a per-exec create stays at epoch 0, and its Exec goes out per-exec', async () => {
    const cp = controlPlane();
    const r = await relay();
    const w = await epochWorker(r.attach);
    const sbx = await cp.create({});
    expect(sbx).toMatchObject({ mode: 'per-exec', idleTimeoutS: 0, modeEpoch: 0 });
    const t = await cp.token(sbx.id);
    const res = await exec(r.exec, { token: t.token, sandboxId: t.wrk, wsk: t.wsk }).done;
    expect(res.code).toBe(status.OK);
    expect(w.execs.map(modeOf)).toEqual([
      {
        workspaceKey: sbx.id,
        mode: SandboxMode.SANDBOX_MODE_PER_EXEC,
        modeEpoch: 0,
        idleTimeoutS: 0,
        keepalive: false,
      },
    ]);
    expect(kindsOf(res.events)).toEqual([['chunk'], ['end']]);
  });

  it('a mode change raises the epoch; set_mode carries it, and the older token goes stale', async () => {
    const cp = controlPlane();
    const r = await relay();
    const w = await epochWorker(r.attach);
    const sbx = await cp.create({ mode: 'lease' });
    const before = await cp.token(sbx.id);

    const changed = await cp.setMode(sbx.id, { mode: 'per-exec' });
    expect(changed.sandbox).toMatchObject({ mode: 'per-exec', modeEpoch: 2 });
    expect(cp.audits).toContainEqual(
      expect.objectContaining({
        decision: 'sandbox_mode_changed',
        fromMode: 'lease',
        toMode: 'per-exec',
        modeEpoch: 2,
      }),
    );

    // The downgrade takes effect at once through set_mode: the frame's mode and epoch come from
    // the set-mode token, whichever valid sandbox token authorizes the call.
    const set = await leaseControl(
      r.exec,
      before.token,
      before.wrk,
      LeaseOp.LEASE_OP_SET_MODE,
      changed.setModeToken,
    );
    expect(set.code).toBe(status.OK);
    expect(w.controls).toEqual([
      expect.objectContaining({
        workspaceKey: sbx.id,
        op: LeaseOp.LEASE_OP_SET_MODE,
        mode: SandboxMode.SANDBOX_MODE_PER_EXEC,
        modeEpoch: 2,
      }),
    ]);
    // A per-exec Exec carries no lease event, so the result reports the mode_change end.
    expect(set.res?.status?.pending).toMatchObject({ state: 'end', reason: 'mode_change' });
    expect(reasons(r.lines).filter((l) => l.audit === 'sandbox_lease_control')).toEqual([
      expect.objectContaining({ op: 'set_mode', outcome: 'ok', mode: 'per-exec', modeEpoch: 2 }),
    ]);

    // A token minted after the change carries the new epoch.
    const after = await cp.token(sbx.id);
    const fresh = await exec(r.exec, { token: after.token, sandboxId: after.wrk, wsk: after.wsk })
      .done;
    expect(fresh.code).toBe(status.OK);
    // The one minted before it still verifies at the relay, and the worker refuses its epoch.
    const stale = await exec(r.exec, {
      token: before.token,
      sandboxId: before.wrk,
      wsk: before.wsk,
    }).done;
    expect(stale.code).not.toBe(status.OK);
    expect(stale.events.map((ev) => ev.error?.message)).toEqual(['stale_mode: epoch 1 is below 2']);
    expect(w.execs.map((e) => [e.mode, e.modeEpoch])).toEqual([
      [SandboxMode.SANDBOX_MODE_PER_EXEC, 2],
      [SandboxMode.SANDBOX_MODE_LEASE, 1],
    ]);
  });

  it('mode-token re-signs the current mode and epoch without raising it', async () => {
    const cp = controlPlane();
    const r = await relay();
    const w = await epochWorker(r.attach);
    const sbx = await cp.create({ mode: 'lease' });
    await cp.setMode(sbx.id, { mode: 'lease', idleTimeoutS: 900 });
    const { setModeToken } = await cp.modeToken(sbx.id);
    expect(await cp.get(sbx.id)).toMatchObject({ mode: 'lease', modeEpoch: 2 });
    const t = await cp.token(sbx.id);
    const set = await leaseControl(r.exec, t.token, t.wrk, LeaseOp.LEASE_OP_SET_MODE, setModeToken);
    expect(set.code).toBe(status.OK);
    expect(w.controls).toEqual([
      expect.objectContaining({ mode: SandboxMode.SANDBOX_MODE_LEASE, modeEpoch: 2 }),
    ]);
    // The idle timeout reaches the worker on the Exec, never on set_mode (ruling R12).
    await exec(r.exec, { token: t.token, sandboxId: t.wrk, wsk: t.wsk }).done;
    expect(w.execs.map(modeOf)).toEqual([
      expect.objectContaining({
        mode: SandboxMode.SANDBOX_MODE_LEASE,
        modeEpoch: 2,
        idleTimeoutS: 900,
      }),
    ]);
  });
});
