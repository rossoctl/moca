import { describe, it, expect } from 'vitest';
import {
  Hello,
  Exec,
  End,
  ExecRequest,
  ExecKind,
  ProcessArgs,
  TrackedProcess,
} from '../src/gen/sandbox/v1/sandbox';
import { Chunk, Stream } from '../src/gen/sandbox/v1/sandbox.js';
import {
  ExecEvent,
  LeaseControlFrame,
  LeaseControlRequest,
  LeaseControlResponse,
  LeaseControlResult,
  LeaseEvent,
  LeaseKeepaliveFrame,
  LeaseKeepaliveRequest,
  LeaseKeepaliveResponse,
  LeaseOp,
  LeaseStatus,
  SandboxMode,
  ServerFrame,
  WorkerFrame,
} from '../src/index.js';

describe('sandbox/v1 generated TypeScript stubs', () => {
  it('round-trips a Hello through binary encode/decode', () => {
    const bytes = Hello.encode({
      sandboxId: 'sbx-1',
      labels: { team: 'alpha' },
      capabilities: ['python3', 'kubectl'],
      image: 'img@sha256:abc',
      arch: 'amd64',
      capacityMax: 4,
      trust: 'trusted',
    }).finish();

    const back = Hello.decode(bytes);
    expect(back.sandboxId).toBe('sbx-1');
    expect(back.labels.team).toBe('alpha');
    expect(back.capabilities).toEqual(['python3', 'kubectl']);
    expect(back.capacityMax).toBe(4);
  });

  it('keeps req_id as a number and stdin as bytes', () => {
    const back = Exec.decode(
      Exec.encode(
        Exec.fromPartial({
          reqId: 7,
          command: 'echo hi',
          stdin: new Uint8Array([1, 2, 3]),
          timeoutS: 30,
          streaming: true,
          workspaceKey: '',
        }),
      ).finish(),
    );
    expect(back.reqId).toBe(7);
    expect(back.streaming).toBe(true);
    expect(Array.from(back.stdin)).toEqual([1, 2, 3]);
  });

  it('carries workspace_key and defaults it to the empty string', () => {
    const back = Exec.decode(
      Exec.encode(
        Exec.fromPartial({
          reqId: 1,
          command: 'cat /workspace/README.md',
          stdin: new Uint8Array(),
          timeoutS: 30,
          streaming: false,
          workspaceKey: 'leaf-abc123',
        }),
      ).finish(),
    );
    expect(back.workspaceKey).toBe('leaf-abc123');

    // Additive and backward-compatible (spec §3.4): a worker or harness that never
    // sets the field reads it as '', which is proto3's default and is exactly what
    // remote-worker's "today's behaviour" pin depends on.
    const old = Exec.decode(
      Exec.encode(
        Exec.fromPartial({
          reqId: 2,
          command: 'true',
          stdin: new Uint8Array(),
          timeoutS: 0,
          streaming: true,
          workspaceKey: '',
        }),
      ).finish(),
    );
    expect(old.workspaceKey).toBe('');
  });

  it('carries ExecRequest.workload, additive: an older encoder reads as the empty string', () => {
    const wl = `w-${'a'.repeat(32)}`;
    const exec = Exec.fromPartial({
      reqId: 1,
      command: 'true',
      stdin: new Uint8Array(),
      timeoutS: 0,
      streaming: true,
      workspaceKey: '',
    });
    const back = ExecRequest.decode(
      ExecRequest.encode({ sandboxId: `${wl}-0`, workload: wl, exec }).finish(),
    );
    expect(back.workload).toBe(wl);
    // Field 3 omitted on the wire, as a harness built before the field sends it.
    const old = ExecRequest.decode(
      ExecRequest.encode({ sandboxId: 'sbx-1', workload: '', exec }).finish(),
    );
    expect(old.workload).toBe('');
  });

  it('preserves a negative exit_code (sint32 zigzag)', () => {
    const back = End.decode(End.encode({ reqId: 7, exitCode: -9, truncated: false }).finish());
    expect(back.exitCode).toBe(-9);
  });

  // #189: truncated travels alongside the command's real exit code, not instead of
  // it. The worker reports what the command did; mapping truncation to a null status
  // is the transport's job (spec §8), so both values must survive the wire together.
  it('carries truncated alongside a real exit_code', () => {
    const back = End.decode(End.encode({ reqId: 7, exitCode: 0, truncated: true }).finish());
    expect(back.truncated).toBe(true);
    expect(back.exitCode).toBe(0);
  });

  // A worker that never drops output never sets the field, and proto3's default must
  // read as "not truncated" — the pre-#189 behaviour, which is correct for it.
  it('defaults truncated to false when a worker omits it', () => {
    const back = End.decode(End.encode({ reqId: 7, exitCode: 0, truncated: false }).finish());
    expect(back.truncated).toBe(false);
  });
});

describe('Chunk stream discriminator (ST3)', () => {
  it('exposes the Stream enum with stdout/stderr', () => {
    expect(Stream.STREAM_STDOUT).toBe(1);
    expect(Stream.STREAM_STDERR).toBe(2);
    expect(Stream.STREAM_UNSPECIFIED).toBe(0);
  });

  it('round-trips a Chunk carrying stderr', () => {
    const c = Chunk.decode(
      Chunk.encode({
        reqId: 7,
        data: new Uint8Array([1, 2]),
        stream: Stream.STREAM_STDERR,
      }).finish(),
    );
    expect(c.reqId).toBe(7);
    expect(c.stream).toBe(Stream.STREAM_STDERR);
    expect([...c.data]).toEqual([1, 2]);
  });
});

// SBX0.3 plan 3: the lease wire. Every addition is a new field or oneof member, so an
// old peer's bytes decode with the new fields at their zero values.
describe('sandbox/v1 lease wire (additive)', () => {
  const event = LeaseEvent.fromPartial({
    reqId: 9,
    state: 'end',
    reason: 'idle',
    atUnixMs: 1_731_400_000_123,
    mode: SandboxMode.SANDBOX_MODE_LEASE_PROCESSES,
    ageMs: 42_000,
    processes: ['p1', 'p2'],
  });
  const status = LeaseStatus.fromPartial({
    mode: SandboxMode.SANDBOX_MODE_LEASE,
    epochKnown: true,
    state: 'active',
    ageMs: 1500,
    idleTimeoutS: 300,
    pending: event,
  });

  it('decodes an Exec written before the change as per-exec, epoch 0, no keepalive', () => {
    // The bytes the pre-change stubs (HEAD 3299cc98) write for
    // {reqId: 2, command: 'true', streaming: true, workspaceKey: 'leaf-1'}.
    const old = Exec.decode(
      Uint8Array.from([
        0x08, 0x02, 0x12, 0x04, 0x74, 0x72, 0x75, 0x65, 0x28, 0x01, 0x32, 0x06, 0x6c, 0x65, 0x61,
        0x66, 0x2d, 0x31,
      ]),
    );
    expect(old.workspaceKey).toBe('leaf-1');
    expect(old.mode).toBe(SandboxMode.SANDBOX_MODE_UNSPECIFIED);
    expect(old.modeEpoch).toBe(0);
    expect(old.idleTimeoutS).toBe(0);
    expect(old.keepalive).toBe(false);
  });

  it('round-trips the Exec lease fields', () => {
    const e = Exec.fromPartial({
      reqId: 1,
      command: 'true',
      workspaceKey: 'leaf-1',
      mode: SandboxMode.SANDBOX_MODE_LEASE,
      modeEpoch: 3,
      idleTimeoutS: 600,
      keepalive: true,
    });
    expect(Exec.decode(Exec.encode(e).finish())).toEqual(e);
  });

  it('pins the SandboxMode and LeaseOp numbers', () => {
    expect(SandboxMode.SANDBOX_MODE_UNSPECIFIED).toBe(0);
    expect(SandboxMode.SANDBOX_MODE_PER_EXEC).toBe(1);
    expect(SandboxMode.SANDBOX_MODE_LEASE).toBe(2);
    expect(SandboxMode.SANDBOX_MODE_LEASE_PROCESSES).toBe(3);
    expect(LeaseOp.LEASE_OP_UNSPECIFIED).toBe(0);
    expect(LeaseOp.LEASE_OP_STATUS).toBe(1);
    expect(LeaseOp.LEASE_OP_RESET).toBe(2);
    expect(LeaseOp.LEASE_OP_SET_MODE).toBe(3);
    expect(LeaseOp.LEASE_OP_SANDBOX_DELETED).toBe(4);
  });

  it('round-trips LeaseEvent.endsByUnixMs (field 8)', () => {
    const expiring = LeaseEvent.fromPartial({
      reqId: 9,
      state: 'expiring',
      atUnixMs: 1_731_400_000_123,
      endsByUnixMs: 1_731_400_600_000,
    });
    expect(LeaseEvent.decode(LeaseEvent.encode(expiring).finish())).toEqual(expiring);
    // tag (8 << 3) | 0 = 0x40 leads the encoding of the field.
    expect(LeaseEvent.encode(LeaseEvent.fromPartial({ endsByUnixMs: 1 })).finish()[0]).toBe(0x40);
  });

  it('round-trips each new message', () => {
    expect(LeaseEvent.decode(LeaseEvent.encode(event).finish())).toEqual(event);
    expect(LeaseStatus.decode(LeaseStatus.encode(status).finish())).toEqual(status);
    const ctl: LeaseControlFrame = {
      ctlId: 5,
      workspaceKey: 'leaf-1',
      op: LeaseOp.LEASE_OP_SET_MODE,
      mode: SandboxMode.SANDBOX_MODE_PER_EXEC,
      modeEpoch: 4,
    };
    expect(LeaseControlFrame.decode(LeaseControlFrame.encode(ctl).finish())).toEqual(ctl);
    const ka: LeaseKeepaliveFrame = { workspaceKey: 'leaf-1' };
    expect(LeaseKeepaliveFrame.decode(LeaseKeepaliveFrame.encode(ka).finish())).toEqual(ka);
    const res: LeaseControlResult = { ctlId: 5, status, error: 'stale_mode: epoch 3 < 4' };
    expect(LeaseControlResult.decode(LeaseControlResult.encode(res).finish())).toEqual(res);
    const req: LeaseControlRequest = {
      sandboxId: 'sbx-1',
      op: LeaseOp.LEASE_OP_RESET,
      setModeToken: 'tok',
    };
    expect(LeaseControlRequest.decode(LeaseControlRequest.encode(req).finish())).toEqual(req);
    const resp: LeaseControlResponse = { status };
    expect(LeaseControlResponse.decode(LeaseControlResponse.encode(resp).finish())).toEqual(resp);
    const kreq: LeaseKeepaliveRequest = { sandboxId: 'sbx-1' };
    expect(LeaseKeepaliveRequest.decode(LeaseKeepaliveRequest.encode(kreq).finish())).toEqual(kreq);
    expect(LeaseKeepaliveResponse.decode(LeaseKeepaliveResponse.encode({}).finish())).toEqual({});
  });

  it('round-trips the new oneof members', () => {
    const ev = ExecEvent.fromPartial({ lease: event });
    expect(ExecEvent.decode(ExecEvent.encode(ev).finish())).toEqual(ev);
    const wl = WorkerFrame.fromPartial({ lease: event });
    expect(WorkerFrame.decode(WorkerFrame.encode(wl).finish())).toEqual(wl);
    const wr = WorkerFrame.fromPartial({ leaseResult: { ctlId: 1 } });
    expect(WorkerFrame.decode(WorkerFrame.encode(wr).finish())).toEqual(wr);
    const sc = ServerFrame.fromPartial({ leaseControl: { ctlId: 1 } });
    expect(ServerFrame.decode(ServerFrame.encode(sc).finish())).toEqual(sc);
    const sk = ServerFrame.fromPartial({ keepalive: { workspaceKey: 'k' } });
    expect(ServerFrame.decode(ServerFrame.encode(sk).finish())).toEqual(sk);
  });
});

// SBX0.3 plan 5 (level 2): process kinds and tracked processes, additive. An Exec from a
// client that predates them carries no field 11 or 12 and decodes as a plain command.
describe('sandbox/v1 process wire (additive)', () => {
  it('pins the ExecKind numbers', () => {
    expect(ExecKind.EXEC_KIND_COMMAND).toBe(0);
    expect(ExecKind.EXEC_KIND_PROCESS_START).toBe(1);
    expect(ExecKind.EXEC_KIND_PROCESS_LIST).toBe(2);
    expect(ExecKind.EXEC_KIND_PROCESS_LOGS).toBe(3);
    expect(ExecKind.EXEC_KIND_PROCESS_STOP).toBe(4);
  });

  it('decodes an Exec written before the change as a command', () => {
    const old = Exec.decode(Uint8Array.from([0x08, 0x02, 0x12, 0x04, 0x74, 0x72, 0x75, 0x65]));
    expect(old.kind).toBe(ExecKind.EXEC_KIND_COMMAND);
    expect(old.process).toBeUndefined();
  });

  it('pins Exec.kind as field 11 and Exec.process as field 12', () => {
    const k = Exec.encode(Exec.fromPartial({ kind: ExecKind.EXEC_KIND_PROCESS_STOP })).finish();
    expect(Array.from(k)).toEqual([0x58, 0x04]);
    const p = Exec.encode(Exec.fromPartial({ process: { name: 'x' } })).finish();
    expect(p[0]).toBe(0x62);
  });

  it('round-trips a process_start Exec with its ProcessArgs', () => {
    const e = Exec.fromPartial({
      reqId: 3,
      command: 'sleep 100',
      kind: ExecKind.EXEC_KIND_PROCESS_START,
      process: ProcessArgs.fromPartial({
        name: 'srv',
        id: 'p1',
        cwd: '/workspace',
        tail: 200,
        signal: 'TERM',
      }),
    });
    expect(Exec.decode(Exec.encode(e).finish())).toEqual(e);
  });

  it('round-trips TrackedProcess with its fields', () => {
    const t = TrackedProcess.fromPartial({
      id: 'p1',
      name: 'srv',
      pid: 4242,
      state: 'killed',
      code: 15,
      ageMs: 9000,
      memoryBytes: 1048576,
    });
    expect(TrackedProcess.decode(TrackedProcess.encode(t).finish())).toEqual(t);
  });

  it('carries LeaseEvent.tracked (field 9) next to processes (field 7)', () => {
    const ev = LeaseEvent.fromPartial({
      reqId: 9,
      state: 'processes_stopped',
      reason: 'mode_change',
      processes: ['srv (pid 4242)'],
      tracked: [TrackedProcess.fromPartial({ id: 'p1', name: 'srv', pid: 4242, state: 'running' })],
    });
    expect(LeaseEvent.decode(LeaseEvent.encode(ev).finish())).toEqual(ev);
    // tag (9 << 3) | 2 = 0x4a leads a LeaseEvent that carries only tracked.
    expect(LeaseEvent.encode(LeaseEvent.fromPartial({ tracked: [{ id: 'p' }] })).finish()[0]).toBe(
      0x4a,
    );
  });

  it('carries LeaseStatus.processes (field 7) and LeaseStatus.stopped (field 8)', () => {
    const st = LeaseStatus.fromPartial({
      mode: SandboxMode.SANDBOX_MODE_LEASE_PROCESSES,
      state: 'active',
      processes: [
        TrackedProcess.fromPartial({
          id: 'p1',
          name: 'srv',
          pid: 7,
          state: 'running',
          memoryBytes: 5,
        }),
      ],
      stopped: [
        TrackedProcess.fromPartial({ id: 'p2', name: 'old', pid: 8, state: 'exited', code: 0 }),
      ],
    });
    expect(LeaseStatus.decode(LeaseStatus.encode(st).finish())).toEqual(st);
    expect(
      LeaseStatus.encode(LeaseStatus.fromPartial({ processes: [{ id: 'p' }] })).finish()[0],
    ).toBe(0x3a);
    expect(
      LeaseStatus.encode(LeaseStatus.fromPartial({ stopped: [{ id: 'p' }] })).finish()[0],
    ).toBe(0x42);
  });
});
