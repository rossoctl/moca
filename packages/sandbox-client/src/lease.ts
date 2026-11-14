import { status } from '@grpc/grpc-js';
import { SandboxMode, type LeaseEvent, type LeaseStatus } from './gen/sandbox/v1/sandbox.js';

/**
 * Lease mode for SBX clients (spec §5, §8.3): the mode names, the lease status as a client reads
 * it, the errors of the lease calls and the one notice formatter that the MCP server, mocactl and
 * (as a Go port, `cmd/sbx/notice.go`) the static client all print. This file is the source of truth
 * for the notice copy.
 */

/** A sandbox's mode as the record and the JWT name it. Rank: per-exec < lease < lease+processes. */
export type SandboxModeName = 'per-exec' | 'lease' | 'lease+processes';

/** The wire mode's name. UNSPECIFIED is per-exec; so is a value this client does not know. */
export function modeName(m: SandboxMode): SandboxModeName {
  switch (m) {
    case SandboxMode.SANDBOX_MODE_LEASE:
      return 'lease';
    case SandboxMode.SANDBOX_MODE_LEASE_PROCESSES:
      return 'lease+processes';
    default:
      return 'per-exec';
  }
}

export type LeaseState = 'none' | 'active' | 'expiring';

/** `LeaseControl`'s answer, read after the op (spec §8.3). */
export interface LeaseStatusView {
  mode: SandboxModeName;
  /** The worker holds a stored epoch for the workspace. */
  epochKnown: boolean;
  state: LeaseState;
  ageMs: number;
  /** 0 = the worker's default. */
  idleTimeoutS: number;
  /** The last undelivered lease event (a start or an end), kept until acknowledged. */
  pending?: LeaseEvent;
}

/** A missing status reads as no lease; a state this client does not know reads as none. */
export function leaseStatusView(s: LeaseStatus | undefined): LeaseStatusView {
  const state: LeaseState = s?.state === 'active' || s?.state === 'expiring' ? s.state : 'none';
  return {
    mode: modeName(s?.mode ?? SandboxMode.SANDBOX_MODE_UNSPECIFIED),
    epochKnown: s?.epochKnown ?? false,
    state,
    ageMs: s?.ageMs ?? 0,
    idleTimeoutS: s?.idleTimeoutS ?? 0,
    ...(s?.pending ? { pending: s.pending } : {}),
  };
}

export type LeaseControlErrorCode =
  | 'unauthenticated'
  | 'denied'
  | 'invalid'
  | 'busy'
  | 'timeout'
  | 'unavailable'
  | 'cancelled'
  | 'failed';

/** The relay's statuses for the lease calls (spec §8.3 table, as built). */
const LEASE_CODES: Partial<Record<number, LeaseControlErrorCode>> = {
  [status.UNAUTHENTICATED]: 'unauthenticated',
  [status.PERMISSION_DENIED]: 'denied',
  [status.INVALID_ARGUMENT]: 'invalid',
  [status.RESOURCE_EXHAUSTED]: 'busy',
  [status.DEADLINE_EXCEEDED]: 'timeout',
  [status.UNAVAILABLE]: 'unavailable',
  [status.CANCELLED]: 'cancelled',
  [status.FAILED_PRECONDITION]: 'failed',
};

/**
 * A `LeaseControl` or `LeaseKeepalive` call that did not end OK. `code` names the relay's status
 * (spec §8.3). `failed` is the worker's answer: `wire` is then its wire string (`stale_mode: …`,
 * `lease_unsupported: …`, `busy: …`). Any status outside the table is `failed` with no `wire`.
 */
export class LeaseControlError extends Error {
  constructor(
    readonly code: LeaseControlErrorCode,
    message: string,
    readonly wire?: string,
    readonly grpcCode?: number,
  ) {
    super(message);
    this.name = 'LeaseControlError';
  }

  /** The error for a lease call that ended with gRPC status `code` and `details`. */
  static fromStatus(code: number, details: string): LeaseControlError {
    const name = LEASE_CODES[code] ?? 'failed';
    const wire = code === status.FAILED_PRECONDITION ? details : undefined;
    return new LeaseControlError(name, details, wire, code);
  }
}

/** The event's time as local 24-hour HH:MM. */
export function hhmm(atUnixMs: number): string {
  const d = new Date(atUnixMs);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * The one line a client prints for a lease event (spec §5), or undefined for a state it does not
 * know. A client shows a start only when no end is shown in the same result.
 */
export function leaseNotice(ev: LeaseEvent, nowMs: number): string | undefined {
  switch (ev.state) {
    case 'end':
      return (
        `[sandbox] guest restarted (${ev.reason}, ${hhmm(ev.atUnixMs)}): ` +
        '/tmp, installs outside /workspace and background processes are gone' +
        ev.processes.map((p) => `; stopped: ${p}`).join('')
      );
    case 'expiring': {
      // Only max_duration expires a lease, so the copy names it whatever `reason` says (P4-R8).
      // A worker that predates ends_by_unix_ms sends 0: no deadline to count down to.
      if (ev.endsByUnixMs <= 0) return '[sandbox] guest restarts soon (max_duration)';
      const min = Math.max(1, Math.ceil((ev.endsByUnixMs - nowMs) / 60_000));
      return `[sandbox] guest restarts within ${min} min (max_duration)`;
    }
    case 'start':
      return `[sandbox] new guest (${modeName(ev.mode)}, ${hhmm(ev.atUnixMs)})`;
    default:
      return undefined;
  }
}

/**
 * The notice lines for one result's lease events, already deduped by the caller (spec §5): a start
 * only when no end is shown with it, and only the last expiring event (one result's Execs may
 * straddle a minute boundary). The MCP server and mocactl both print these.
 */
export function noticeLines(fresh: LeaseEvent[], nowMs: number): string[] {
  const ended = fresh.some((ev) => ev.state === 'end');
  const lastExpiring = fresh.map((ev) => ev.state).lastIndexOf('expiring');
  const lines: string[] = [];
  fresh.forEach((ev, i) => {
    if (ev.state === 'start' && ended) return;
    if (ev.state === 'expiring' && i !== lastExpiring) return;
    const l = leaseNotice(ev, nowMs);
    if (l !== undefined) lines.push(l);
  });
  return lines;
}

/**
 * Lease events are best-effort and may repeat (spec §5): this passes each event, by its state and
 * `at_unix_ms`, once for the life of the deduper (the state too, so an end and the next lease's
 * start in the same millisecond are both shown). An `expiring` event is never deduped, since every
 * result carries it while the lease is expiring, and it marks nothing seen.
 */
export class NoticeDedupe {
  private readonly seen = new Set<string>();
  /** The newest `at_unix_ms` marked seen. */
  private newestMs = -Infinity;

  take(evs: LeaseEvent[]): LeaseEvent[] {
    return evs.filter((ev) => ev.state === 'expiring' || this.mark(ev));
  }

  /**
   * Marks `ev` seen with no notice, for a caller that reports it itself (the MCP `reset`, as
   * mocactl's P4-R17): true when `ev` was not seen yet and is newer than every event seen, so it is
   * the caller's own; otherwise false, and nothing is marked.
   */
  claim(ev: LeaseEvent): boolean {
    return this.claimable(ev) && this.mark(ev);
  }

  /** Whether `claim(ev)` would succeed, marking nothing: a caller may claim it later. */
  claimable(ev: LeaseEvent): boolean {
    return (
      ev.state !== 'expiring' &&
      ev.atUnixMs > this.newestMs &&
      !this.seen.has(`${ev.state}:${ev.atUnixMs}`)
    );
  }

  private mark(ev: LeaseEvent): boolean {
    const key = `${ev.state}:${ev.atUnixMs}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.newestMs = Math.max(this.newestMs, ev.atUnixMs);
    return true;
  }
}
