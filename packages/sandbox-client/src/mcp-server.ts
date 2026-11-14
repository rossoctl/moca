// The low-level `Server`, not `McpServer`: it takes the tools' JSON Schemas (Pi's, verbatim) as they
// are, so this package needs no zod (its runtime dependencies stay the three of ADR-0042). The SDK
// marks it deprecated only in favour of the zod-based high-level API.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ExecAbortedError, ExecMachineryError, ExecRefusedError, type Exec } from './exec-conn.js';
import type { LeaseEvent } from './gen/sandbox/v1/sandbox.js';
import {
  hhmm,
  LeaseControlError,
  noticeLines,
  NoticeDedupe,
  type SandboxModeName,
} from './lease.js';
import {
  LEASE_RULE,
  sandboxTools,
  ToolInputError,
  WORKSPACE,
  type LeaseCall,
  type ToolResult,
} from './tools.js';

/**
 * The sandbox MCP server (SBX0 spec §6.4): the tools over one sandbox's Exec, and its lease (plan
 * 4): each result is prefixed with the notices of the lease events its Execs carried, `reset` ends
 * the lease and `sandbox_info` shows it. Transport-free: `mocactl sbx mcp` connects it to stdio,
 * the tests to an in-memory pair.
 */

/** One line per tool call for the flight recorder. Never command output. */
export interface CallRecord {
  /** ISO time the call arrived. */
  ts: string;
  tool: string;
  /** Arrival to answer, queueing included. */
  ms: number;
  /** Execs this call made: 1 per tool, 2 for edit, 0 for sandbox_info, reset and any refused call. */
  execs: number;
  /** False for a tool error of any kind, the command's own non-zero exit included. */
  ok: boolean;
  /** One line, set only when the failure was not the command's: never command output. */
  error?: string;
}

/** `sandbox_info`'s text, and the sandbox's mode as the record says it now. */
export interface SandboxInfo {
  text: string;
  mode: SandboxModeName;
}

export interface SandboxMcpOptions {
  exec: Exec;
  /**
   * `sandbox_info`'s text, before the lease fields, and the record's current mode, which every
   * lease field follows; a bare string means the mode at start. Costs no Exec, and is never queued.
   */
  info: () => Promise<string | SandboxInfo>;
  /** The sandbox's lease calls: `reset`, and the status `sandbox_info` shows. */
  lease: LeaseCall;
  /** The sandbox's mode at start, for the tool and rule texts (default per-exec). */
  mode?: SandboxModeName;
  /**
   * The mode claim of the latest sandbox token minted, undefined before the first mint. When set it
   * decides, over the record, whether `reset` and `sandbox_info` ask the lease at all: the record
   * read at start may be stale, a token is minted from the record as it is now. Before the first
   * mint both re-read the record through `info`.
   */
  leaseMode?: () => SandboxModeName | undefined;
  /** Called once per call. A recorder that throws never fails the call. */
  record?: (r: CallRecord) => void;
  /** How long a call may wait behind this server's running one before it is refused as busy. */
  busyWaitMs?: number;
  /** Epoch ms; tests only. */
  now?: () => number;
  workspace?: string;
  /** The sandbox's expiresAt (epoch s), named when the sandbox turns out to have expired. */
  expiresAt?: number;
  name?: string;
  version?: string;
}

/** Spec §6.4: the default wait before a call is refused as busy. */
export const DEFAULT_BUSY_WAIT_MS = 30_000;

/**
 * The sandbox rules (spec §6.3), as Markdown: the server's instructions, and the body of the block
 * `sbx up` writes into CLAUDE.md / AGENTS.md. The instructions are what is sure to reach the agent:
 * every MCP client receives them on connecting, while Claude Code does not load a CLAUDE.md that
 * `sbx up`'s own `Read` deny covers (#568).
 */
export const sandboxRules = (ws: string, mode: SandboxModeName = 'per-exec'): string => {
  const noBackground =
    'Never start background jobs, servers or watchers expecting them to keep running; chain the work into one command instead.';
  const leased = mode !== 'per-exec';
  return [
    `The code lives in a remote sandbox at \`${ws}\`: use the \`sandbox\` MCP tools for everything.`,
    '',
    leased
      ? `- Lease mode: ${LEASE_RULE}. ${noBackground}`
      : `- Every tool call runs in a fresh VM, and no process survives it. ${noBackground}`,
    leased
      ? `- Files under \`${ws}\` persist between calls; anything else lasts at most until the guest restarts.`
      : `- Files under \`${ws}\` persist between calls; nothing else does.`,
    '- There is no network: packages cannot be installed from the internet.',
    '- Calls run one at a time, so batch the work: read several files in one `bash` call, and run the tests in one call after editing.',
  ].join('\n');
};

/** The server's instructions for the default workspace in per-exec mode. */
export const MCP_INSTRUCTIONS = sandboxRules(WORKSPACE);

/** The tool error texts that are not the command's own (plan 1c R4). */
export const SANDBOX_BUSY_TEXT =
  'sandbox busy: another client of this sandbox has Execs in flight; retry later';
export const TEMPLATE_BUSY_TEXT = 'template busy; retry later';
/** What a failure after the command started adds: it may have changed files (final review M2). */
const MAY_HAVE_RUN = 'the command may have partly run';
export const TOKEN_EXPIRED_TEXT =
  'the sandbox token expired during the command, so the relay cancelled it; this is not your ' +
  `command's output, and ${MAY_HAVE_RUN}. Retry it, split into shorter steps ` +
  'if it is long.';
const CANCELLED = 'cancelled by the client';
const UP = 'run `mocactl sbx up` for a new one';

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const fail = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/**
 * A terminated sandbox, as the token source reports it: mocactl's `ApiError` with code
 * `sandbox_terminated` (HTTP 409), checked structurally so this package never imports mocactl.
 */
function terminated(err: unknown): 'deleted' | 'expired' | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; reason?: unknown; message?: unknown };
  if (e.code !== 'sandbox_terminated') return undefined;
  if (e.reason === 'deleted' || e.reason === 'expired') return e.reason;
  // mocactl's ApiError carries the control plane's `reason`; without one (another token source),
  // its message is "sandbox was deleted" or "sandbox has expired".
  return typeof e.message === 'string' && /deleted/.test(e.message) ? 'deleted' : 'expired';
}

/**
 * The one text for an Exec failure that was not the command's outcome (spec §6.4), shared by the
 * MCP server and `mocactl sbx`; undefined for any other error. `audience: 'model'` (the default)
 * adds "not your command's output" to a machinery failure, which a model needs told and a person
 * at a terminal (`'cli'`) does not.
 */
export function execFailureText(
  err: unknown,
  o: { audience?: 'model' | 'cli' } = {},
): string | undefined {
  if (err instanceof ExecMachineryError) {
    switch (err.kind) {
      case 'busy':
        return SANDBOX_BUSY_TEXT;
      case 'template_busy':
        return TEMPLATE_BUSY_TEXT;
      case 'token_expired':
        return TOKEN_EXPIRED_TEXT;
      case 'expiring':
        return err.message; // the sandbox expires in N s; pull your work now
      default: {
        const what =
          o.audience === 'cli' ? 'sandbox failure' : "sandbox failure, not your command's output";
        const ran = err.mayHaveRun ? `; ${MAY_HAVE_RUN}` : '';
        return `${what}: ${err.message.replace(/^sandbox failure: /, '')}${ran}`;
      }
    }
  }
  if (err instanceof ExecRefusedError) {
    return `the sandbox refused the call (${err.message}). If it expired or was deleted, ${UP}.`;
  }
  return undefined;
}

/** The tool error for anything a tool threw: never shown as the command's output. */
function describe(err: unknown, expiresAt?: number): string {
  if (err instanceof ToolInputError) return `invalid input: ${err.message}`;
  if (err instanceof LeaseControlError)
    return `the lease call failed (${err.code}): ${err.message}`;
  const exec = execFailureText(err);
  if (exec !== undefined) return exec;
  const gone = terminated(err);
  if (gone === 'deleted') return `sandbox was deleted; ${UP}`;
  if (gone === 'expired') {
    const on = expiresAt ? ` on ${new Date(expiresAt * 1000).toISOString()}` : '';
    return `sandbox expired${on}; ${UP}`;
  }
  return `sandbox unavailable: ${err instanceof Error ? err.message : String(err)}`;
}

/** What a call acts on, one line, at most 80 characters: the busy message names it. */
function detailOf(tool: string, args: Record<string, unknown>): string {
  const target = tool === 'bash' ? args.command : (args.path ?? args.pattern);
  const raw = tool === 'bash' ? String(target ?? '') : `${tool} ${String(target ?? '')}`;
  const line = oneLine(raw);
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

type Turn = 'go' | 'busy' | 'cancelled';

/**
 * This server's Exec calls, one at a time in arrival order (spec §6.4). The worker serializes them
 * anyway; doing it here is what lets a call that would wait too long be refused unsent, naming the
 * call it would wait behind.
 */
/** @internal Exported for its unit test only. */
export function line(waitMs: number, now: () => number) {
  let running: { detail: string; since: number } | undefined;
  const waiting: Array<{ go: () => void }> = [];

  const take = (detail: string) => {
    running = { detail, since: now() };
  };
  const release = () => {
    running = undefined;
    const next = waiting.shift();
    next?.go();
  };
  const acquire = (detail: string, signal: AbortSignal): Promise<Turn> => {
    // An abort listener never fires for a signal that is already aborted: refuse that call now.
    if (signal.aborted) return Promise.resolve('cancelled');
    if (!running && waiting.length === 0) {
      take(detail);
      return Promise.resolve('go');
    }
    return new Promise<Turn>((resolve) => {
      const leave = (t: Turn) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        const i = waiting.indexOf(me);
        if (i >= 0) waiting.splice(i, 1);
        resolve(t);
      };
      const me = {
        go: () => {
          take(detail);
          leave('go');
        },
      };
      const onAbort = () => leave('cancelled');
      const timer = setTimeout(() => leave('busy'), waitMs);
      signal.addEventListener('abort', onAbort, { once: true });
      waiting.push(me);
    });
  };
  const busy = (): string => {
    const r = running;
    const what = r?.detail || 'a call';
    return `sandbox busy: \`${what}\` has been running for ${elapsed(r ? now() - r.since : 0)}; retry later or wait for it`;
  };
  return { acquire, release, busy };
}

export function createSandboxMcpServer(o: SandboxMcpOptions): Server {
  const ws = o.workspace ?? WORKSPACE;
  const mode = o.mode ?? 'per-exec';
  const now = o.now ?? Date.now;
  // One deduper per server: an event repeated on a later result is shown once (spec §5).
  const dedupe = new NoticeDedupe();
  let lastEnd: LeaseEvent | undefined;
  /** Keeps `lastEnd` the newest end among `evs` and what it was. */
  const noteEnds = (evs: LeaseEvent[]) => {
    for (const ev of evs) {
      if (ev.state === 'end' && (!lastEnd || ev.atUnixMs >= lastEnd.atUnixMs)) lastEnd = ev;
    }
  };
  /**
   * The events of a cancelled call, whose result nobody receives: shown on the next result, so no
   * lease end goes unsaid.
   */
  const held: LeaseEvent[] = [];
  /**
   * The end the running `reset` reported itself, claimed when its result is sent. Resets run one
   * at a time (the queue), so one slot is enough.
   */
  let ownEnd: LeaseEvent | undefined;

  /**
   * The lease fields of `sandbox_info` for the current mode (the latest token's, else the
   * record's). A per-exec sandbox has no lease to ask about (P4-R9: the default deployment's worker
   * would refuse the status). A failed status is shown, never a failed tool.
   */
  const leaseInfo = async (current: SandboxModeName): Promise<string[]> => {
    const lines = [`mode: ${current}`];
    if (current === 'per-exec') {
      lines.push('lease: none (per-exec)');
    } else {
      try {
        const v = await o.lease('status');
        const idle = `${v.idleTimeoutS}s${v.idleTimeoutS === 0 ? ' (the worker default)' : ''}`;
        lines.push(
          `lease: ${v.state}`,
          `age: ${Math.floor(v.ageMs / 1000)}s`,
          `idle timeout: ${idle}`,
        );
      } catch (err) {
        const code = err instanceof LeaseControlError ? err.code : 'unavailable';
        lines.push(`lease: unknown (${code})`);
      }
    }
    const end = lastEnd ? `${lastEnd.reason}, ${hhmm(lastEnd.atUnixMs)}` : 'none';
    // Plan 5 tracks processes; until then there are none to show.
    lines.push(`last end: ${end}`, 'tracked processes: none');
    return lines;
  };
  /** The record as `o.info` reads it now; a bare string means the mode at start. */
  const current = async (): Promise<SandboxInfo> => {
    const got = await o.info();
    return typeof got === 'string' ? { text: got, mode } : got;
  };
  const info = async (): Promise<string> => {
    const cur = await current();
    // A held end is this result's notice: `last end` names it too.
    noteEnds(held);
    return [cur.text, ...(await leaseInfo(o.leaseMode?.() ?? cur.mode))].join('\n');
  };
  /**
   * The notice lines for one result's lease events: a start only when no end is shown, and only
   * the last expiring event (edit's two Execs may straddle a minute boundary).
   */
  const notices = (events: LeaseEvent[]): string[] => {
    const fresh = dedupe.take(events);
    noteEnds(fresh);
    return noticeLines(fresh, now());
  };

  const tools = sandboxTools({
    info,
    workspace: ws,
    mode,
    lease: o.lease,
    // Before the first mint the record read at start may be stale: read it again (one GET).
    currentMode: async () => o.leaseMode?.() ?? (await current()).mode,
    // The reset's own end, newer than anything seen: `reset`'s text says it, so the next
    // result's notices do not repeat it (as mocactl's P4-R17), and `last end` names it. It is
    // claimed only once the call's result is sent (`run`): a reply that lands as the call is
    // cancelled is discarded, and its end must stay deliverable as a notice.
    resetEnded: (p) => {
      if (p?.state !== 'end' || p.reason !== 'reset' || !dedupe.claimable(p)) return false;
      ownEnd = p;
      return true;
    },
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const queue = line(o.busyWaitMs ?? DEFAULT_BUSY_WAIT_MS, now);
  const server = new Server(
    { name: o.name ?? 'moca-sandbox', version: o.version ?? '0.0.0' },
    { capabilities: { tools: {} }, instructions: sandboxRules(ws, mode) },
  );
  const listed: Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Tool['inputSchema'],
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const started = now();
    let execs = 0;
    const record = (ok: boolean, error?: string) => {
      try {
        o.record?.({
          ts: new Date(started).toISOString(),
          tool: name,
          ms: Math.max(0, now() - started),
          execs,
          ok,
          ...(error !== undefined ? { error: oneLine(error) } : {}),
        });
      } catch {
        // The flight recorder is diagnostics: a full disk must not fail the agent's call.
      }
    };
    // `recorded` is the record's copy when it must differ from what the agent sees.
    const refuse = (text: string, recorded = text): CallToolResult => {
      record(false, recorded);
      return fail(text);
    };

    const tool = byName.get(name);
    if (!tool) return refuse(`unknown tool: ${name}`);
    // Every lease event this call's Execs carried, a failed Exec's included (P4-R5).
    const events: LeaseEvent[] = [];
    const counted: Exec = async (command, opts) => {
      execs++;
      try {
        const r = await o.exec(command, opts);
        events.push(...(r.lease ?? []));
        return r;
      } catch (err) {
        // A failed, refused or aborted Exec still carried its events: the worker acked them.
        if (
          err instanceof ExecMachineryError ||
          err instanceof ExecRefusedError ||
          err instanceof ExecAbortedError
        ) {
          events.push(...err.lease);
        }
        throw err;
      }
    };
    /** The result with its notice lines first, before the output or the error text. */
    const noticed = (r: CallToolResult): CallToolResult => {
      const lines = notices([...held.splice(0), ...events]);
      if (lines.length === 0) return r;
      const [first, ...rest] = r.content;
      if (first?.type === 'text') {
        return {
          ...r,
          content: [{ ...first, text: `${lines.join('\n')}\n${first.text}` }, ...rest],
        };
      }
      return { ...r, content: [{ type: 'text', text: lines.join('\n') }, ...r.content] };
    };
    const run = async (): Promise<CallToolResult> => {
      // Only the reset sets or reads `ownEnd`: sandbox_info is never queued, and may run beside it.
      const resets = tool.name === 'reset';
      try {
        const r: ToolResult = await tool.run(args, counted, extra.signal);
        const own = resets ? ownEnd : undefined;
        if (resets) ownEnd = undefined;
        if (extra.signal.aborted) {
          // Resolved as the cancel arrived: the SDK discards this result, so its notices wait for
          // the next one instead of being marked seen here (review #4569829034), and a reset's
          // own end is not claimed: nobody reads the text that says it.
          held.push(...events);
          return refuse(CANCELLED);
        }
        if (own && dedupe.claim(own)) noteEnds([own]);
        record(!r.isError);
        return noticed(r as CallToolResult);
      } catch (err) {
        if (resets) ownEnd = undefined;
        // The SDK sends nothing for a cancelled request; the record says why it ended.
        if (extra.signal.aborted) {
          held.push(...events);
          return refuse(CANCELLED);
        }
        return noticed(refuse(oneLine(describe(err, o.expiresAt))));
      }
    };

    if (tool.name === 'sandbox_info') return run(); // costs no VM: never queued

    const turn = await queue.acquire(detailOf(tool.name, args), extra.signal);
    // The record leaves out the running call's command text: a command line can hold a secret.
    if (turn === 'busy')
      return refuse(queue.busy(), 'sandbox busy (client-side): waited behind a running call');
    if (turn === 'cancelled') return refuse(CANCELLED);
    try {
      return await run();
    } finally {
      queue.release();
    }
  });

  return server;
}
