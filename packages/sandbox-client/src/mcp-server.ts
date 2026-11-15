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
import {
  ExecMachineryError,
  ExecRefusedError,
  leaseEventsOf,
  ProcessError,
  type Exec,
  type ProcessCall,
} from './exec-conn.js';
import type { LeaseEvent } from './gen/sandbox/v1/sandbox.js';
import {
  ageText,
  hhmm,
  LeaseControlError,
  noticeLines,
  NoticeDedupe,
  processRow,
  shownProcessId,
  type SandboxModeName,
} from './lease.js';
import {
  LEASE_PROCESSES_RULE,
  LEASE_RULE,
  PROCESS_RULE,
  PROCESS_TOOL_NAMES,
  sandboxTools,
  ToolInputError,
  WORKSPACE,
  type LeaseCall,
  type SandboxTool,
  type ToolResult,
} from './tools.js';

/**
 * The sandbox MCP server (SBX0 spec §6.4): the tools over one sandbox's Exec, and its lease (plan
 * 4): each result is prefixed with the notices of the lease events its Execs carried, `reset` ends
 * the lease and `sandbox_info` shows it. At lease+processes (plan 5) it also serves the process
 * tools; the tool list follows the latest token's mode, and the client is told when it changes
 * (`tokenMinted`). Transport-free: `mocactl sbx mcp` connects it to stdio, the tests to an
 * in-memory pair.
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
  /** The sandbox's process calls (plan 5): the process tools' one Exec each. */
  process?: ProcessCall;
  /** The sandbox id the texts name (the §7 refusal's `mocactl sbx mode <id>`). */
  sandboxId?: string;
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
   * mint both re-read the record through `info`. It also picks the tools listed and the process
   * tools' gate, as `tokenMinted` does; before any mint, `mode` does.
   */
  leaseMode?: () => SandboxModeName | undefined;
  /**
   * Mints a fresh sandbox token and answers its mode (P5-R29): the gate asks it once when a
   * process tool is called below lease+processes, since the user may have upgraded since the held
   * token. A caller with no token yet mints its first one. Without it, the gate decides from the
   * held token's mode alone.
   */
  refreshMode?: (signal: AbortSignal) => Promise<SandboxModeName | undefined>;
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
    mode === 'lease+processes'
      ? `${PROCESS_RULE} Start servers and watchers that must keep running with \`process_start\`; \`process_list\`, \`process_logs\` and \`process_stop\` manage them.`
      : 'Never start background jobs, servers or watchers expecting them to keep running; chain the work into one command instead.';
  const leased = mode !== 'per-exec';
  const leaseRule = mode === 'lease+processes' ? LEASE_PROCESSES_RULE : LEASE_RULE;
  return [
    `The code lives in a remote sandbox at \`${ws}\`: use the \`sandbox\` MCP tools for everything.`,
    '',
    leased
      ? `- Lease mode: ${leaseRule}. ${noBackground}`
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
/** The §7 refusal of a process tool below lease+processes, as the model is told it. */
export const processesNotEnabledText = (sandboxId: string): string =>
  `processes not enabled for this sandbox; ask the user to run: mocactl sbx mode ${sandboxId} lease+processes`;
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
  o: { audience?: 'model' | 'cli'; sandboxId?: string } = {},
): string | undefined {
  if (err instanceof ProcessError) return processFailureText(err, o);
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

/**
 * The relay's `lease_unsupported:` detail when the sandbox's worker does not advertise the
 * sbx:lease-processes-v1 capability (ruling P5-R37; packages/sandbox-relay WORKER_WITHOUT_PROCESSES,
 * the same text): the worker predates level 2, so the relay sent nothing.
 */
const WORKER_WITHOUT_PROCESSES_DETAIL = "this sandbox's worker does not support tracked processes";

/**
 * The text for a process call's wire refusal (spec §7): nothing ran. `processes_not_enabled`
 * is the §7 refusal, naming the sandbox (`<id>` when it is not known).
 */
function processFailureText(
  err: ProcessError,
  o: { audience?: 'model' | 'cli'; sandboxId?: string },
): string {
  const d = err.detail;
  switch (err.code) {
    case 'processes_not_enabled': {
      const id = o.sandboxId ?? '<id>';
      return o.audience === 'cli'
        ? `processes not enabled for this sandbox; run: mocactl sbx mode ${id} lease+processes`
        : processesNotEnabledText(id);
    }
    // A person at a terminal has the sbx proc commands, not the model's tools.
    case 'process_not_found': {
      // The guest names an id bare; no name is shaped like one (P5-R33), so a decimal detail is
      // an id, shown as the rows show it (final review M2).
      const who = /^\d+$/.test(d) ? shownProcessId(d) : d;
      return `no tracked process ${who}; ${o.audience === 'cli' ? 'mocactl sbx proc ls' : 'process_list'} shows them`;
    }
    case 'process_limit':
      return `too many tracked processes: ${d}; stop one with ${o.audience === 'cli' ? 'mocactl sbx proc stop' : 'process_stop'} first`;
    case 'process_name_taken':
      return `a running process is already named ${d}; choose another name, or stop it first`;
    case 'process_cwd':
      return `invalid cwd: ${d}`;
    case 'process_name_invalid':
      return `invalid name: ${d}`;
    case 'process_signal':
      return `invalid signal: ${d}`;
    case 'lease_unsupported':
      // Not something the user can change with a mode: the deployment's worker is too old.
      if (d === WORKER_WITHOUT_PROCESSES_DETAIL) {
        return `tracked processes are not available on this sandbox's worker yet (${o.audience === 'cli' ? 'ask the operator' : 'ask the user to tell the operator'})`;
      }
      return `this sandbox's guest cannot run tracked processes: ${d}`;
    default:
      return `the sandbox refused the process call (${err.message})`;
  }
}

/** The tool error for anything a tool threw: never shown as the command's output. */
function describe(err: unknown, expiresAt?: number, sandboxId?: string): string {
  if (err instanceof ToolInputError) return `invalid input: ${err.message}`;
  if (err instanceof LeaseControlError)
    return `the lease call failed (${err.code}): ${err.message}`;
  const exec = execFailureText(err, sandboxId !== undefined ? { sandboxId } : {});
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
  const target =
    tool === 'bash'
      ? args.command
      : (args.path ?? args.pattern ?? args.command ?? args.id ?? args.name);
  const raw = tool === 'bash' ? String(target ?? '') : `${tool} ${String(target ?? '')}`;
  const line = oneLine(raw);
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
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
    return `sandbox busy: \`${what}\` has been running for ${ageText(r ? now() - r.since : 0)}; retry later or wait for it`;
  };
  return { acquire, release, busy };
}

/**
 * The server, and `tokenMinted`: the caller tells it the mode of each sandbox token minted. The
 * tool list follows that mode (plan 5): when a mint's mode differs from the one the client last
 * listed the tools under, it is sent `notifications/tools/list_changed`, once until it lists again
 * (P5-R27). The instructions stay those of the mode at start: MCP sends them once, on connecting.
 */
export type SandboxMcpServer = Server & { tokenMinted(mode: SandboxModeName): void };

export function createSandboxMcpServer(o: SandboxMcpOptions): SandboxMcpServer {
  const ws = o.workspace ?? WORKSPACE;
  const mode = o.mode ?? 'per-exec';
  const now = o.now ?? Date.now;
  /** The mode `tokenMinted` was last told; undefined before the first mint. */
  let mintedMode: SandboxModeName | undefined;
  /** The mode the last tools/list answered under; undefined before the first. */
  let listedMode: SandboxModeName | undefined;
  /** list_changed was sent since the last tools/list: the client will list again anyway. */
  let changeSent = false;
  /** The latest minted token's mode, undefined before the first mint. */
  const tokenMode = (): SandboxModeName | undefined => o.leaseMode?.() ?? mintedMode;
  /** The mode the tools follow: the latest token's, else the record's at start. */
  const toolMode = (): SandboxModeName => tokenMode() ?? mode;
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
    let tracked = ['tracked processes: none'];
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
        // The full table (plan 5), exited entries included, so the agent can read why one died.
        if (v.processes?.length) {
          // The worker's mirror, refreshed by each call (P5-R38): a status touches no guest,
          // so it cannot touch the lease's idle clock either.
          tracked = [
            'tracked processes (as of the last call):',
            ...v.processes.map((p) => `  ${processRow(p)}`),
          ];
        }
      } catch (err) {
        const code = err instanceof LeaseControlError ? err.code : 'unavailable';
        lines.push(`lease: unknown (${code})`);
        tracked = ['tracked processes: unknown'];
      }
    }
    const end = lastEnd ? `${lastEnd.reason}, ${hhmm(lastEnd.atUnixMs)}` : 'none';
    lines.push(`last end: ${end}`, ...tracked);
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
    return [cur.text, ...(await leaseInfo(tokenMode() ?? cur.mode))].join('\n');
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

  const toolOptions: Parameters<typeof sandboxTools>[0] = {
    info,
    workspace: ws,
    lease: o.lease,
    // Before the first mint the record read at start may be stale: read it again (one GET).
    currentMode: async () => tokenMode() ?? (await current()).mode,
    // The reset's own end, newer than anything seen: `reset`'s text says it, so the next
    // result's notices do not repeat it (as mocactl's P4-R17), and `last end` names it. It is
    // claimed only once the call's result is sent (`run`): a reply that lands as the call is
    // cancelled is discarded, and its end must stay deliverable as a notice.
    resetEnded: (p) => {
      if (p?.state !== 'end' || p.reason !== 'reset' || !dedupe.claimable(p)) return false;
      ownEnd = p;
      return true;
    },
  };
  /** Each mode's tools, with its texts (the process tools at lease+processes only), built once. */
  const sets = new Map<SandboxModeName, { byName: Map<string, SandboxTool>; listed: Tool[] }>();
  const toolsFor = (m: SandboxModeName) => {
    let set = sets.get(m);
    if (!set) {
      const tools = sandboxTools({ ...toolOptions, mode: m });
      set = {
        byName: new Map(tools.map((t) => [t.name, t])),
        listed: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Tool['inputSchema'],
        })),
      };
      sets.set(m, set);
    }
    return set;
  };
  const isProcessTool = (name: string) => (PROCESS_TOOL_NAMES as readonly string[]).includes(name);
  const queue = line(o.busyWaitMs ?? DEFAULT_BUSY_WAIT_MS, now);
  const server = new Server(
    { name: o.name ?? 'moca-sandbox', version: o.version ?? '0.0.0' },
    { capabilities: { tools: { listChanged: true } }, instructions: sandboxRules(ws, mode) },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const m = toolMode();
    listedMode = m;
    changeSent = false;
    return { tools: toolsFor(m).listed };
  });

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

    let m = toolMode();
    if (isProcessTool(name) && m !== 'lease+processes' && o.refreshMode) {
      // The held token may predate the user's upgrade (P5-R29): one fresh mint reads the record
      // as it is now. One per call, and none when the call's own mint is the first.
      try {
        m = (await o.refreshMode(extra.signal)) ?? toolMode();
      } catch (err) {
        if (extra.signal.aborted) return refuse(CANCELLED);
        return refuse(oneLine(describe(err, o.expiresAt, o.sandboxId)));
      }
    }
    // Below lease+processes a process tool is refused unsent (spec §7), whatever list the client
    // holds: one listed under an earlier mode may still offer it (P5-R27).
    if (isProcessTool(name) && m !== 'lease+processes') {
      return refuse(processesNotEnabledText(o.sandboxId ?? '<id>'));
    }
    const tool = toolsFor(m).byName.get(name);
    if (!tool) return refuse(`unknown tool: ${name}`);
    // Every lease event this call's Execs carried, a failed Exec's included (P4-R5).
    const events: LeaseEvent[] = [];
    /** A failed, refused or aborted Exec still carried its events: the worker acked them. */
    const keepEvents = (err: unknown) => {
      events.push(...leaseEventsOf(err));
    };
    const counted: Exec = async (command, opts) => {
      execs++;
      try {
        const r = await o.exec(command, opts);
        events.push(...(r.lease ?? []));
        return r;
      } catch (err) {
        keepEvents(err);
        throw err;
      }
    };
    const processCall = o.process;
    const countedProcess: ProcessCall | undefined = processCall
      ? async (op, a, opts) => {
          execs++;
          try {
            const r = await processCall(op, a, opts);
            events.push(...r.lease);
            return r;
          } catch (err) {
            keepEvents(err);
            throw err;
          }
        }
      : undefined;
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
        const r: ToolResult = await tool.run(args, counted, extra.signal, countedProcess);
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
        return noticed(refuse(oneLine(describe(err, o.expiresAt, o.sandboxId))));
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

  const tokenMinted = (minted: SandboxModeName) => {
    mintedMode = minted;
    // Against the mode the client listed the tools under, the one source (Minor 4): none if it
    // never listed (its first list will be right), and one notice until it lists again.
    if (listedMode !== undefined && minted !== listedMode && !changeSent) {
      changeSent = true;
      // A client gone or not yet connected has no list to refresh.
      server.sendToolListChanged().catch(() => {});
    }
  };
  return Object.assign(server, { tokenMinted });
}
