import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  createSandboxMcpServer,
  LEASE_RULE,
  LeaseControlError,
  type Exec,
  type LeaseCall,
  type SandboxModeName,
} from '@moca/sandbox-client';
import { sanitizeRemote } from '../core/sanitize.js';
import { VERSION } from '../version.js';
import type { SbxSandbox, SbxToken } from './api.js';
import type { SbxCtx } from './commands.js';
import { jwtMode, openExec, type ExecFactory, type OpenedExec } from './exec.js';
import { recordCall } from './recorder.js';

/** The lease keepalive's cadence (spec §8.3), while the current sandbox token is a lease mode's. */
export const KEEPALIVE_MS = 30_000;

/** The record's mode: absent, or one this client does not know, reads as per-exec. */
const recordMode = (s: SbxSandbox): SandboxModeName =>
  s.mode === 'lease' || s.mode === 'lease+processes' ? s.mode : 'per-exec';

/**
 * The stdio transport, closed when stdin ends: the SDK's own one only stops on a read error, so a
 * client that just closes the pipe would leave the server (and its gRPC channel) running.
 */
export async function stdioTransport(): Promise<Transport> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const t = new StdioServerTransport();
  const end = () => void t.close().catch(() => {});
  process.stdin.once('end', end);
  process.stdin.once('close', end);
  return t;
}

/**
 * `mocactl sbx mcp` (SBX0 §6.4): the sandbox MCP server bound to one sandbox, on the given transport
 * (stdio in production). Resolves when the transport closes or `c.signal` aborts. Writes nothing to
 * stdout itself.
 *
 * The sandbox is looked up first, so a wrong id fails at start; its mode then picks the tool and
 * rule texts. The Exec connection opens at the first call, so a sandbox that has expired or was
 * deleted still serves, and every call says so ("sandbox expired on …; run `mocactl sbx up`")
 * instead of the server failing to start.
 *
 * Keepalive (spec §4, §8.3): while the `mode` claim of the latest sandbox token minted is a lease
 * mode, Execs set `keepalive` and a 30 s interval sends `leaseKeepalive()`. A mint that says
 * per-exec (the owner downgraded) stops it; closing the server clears it.
 */
export async function serveSbxMcp(
  c: SbxCtx,
  id: string,
  transport: Transport,
  factory?: ExecFactory,
): Promise<void> {
  const s = await c.api.getSandbox(id);
  const mode = recordMode(s);
  let conn: Promise<OpenedExec> | undefined;
  /** The latest minted token's mode claim (undefined before the first mint). */
  let tokenMode: SandboxModeName | undefined;
  /** That claim is a lease mode. */
  let leased = false;
  let beat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let warned = false;
  const stopBeat = () => {
    clearInterval(beat);
    beat = undefined;
  };
  const keepalive = () => {
    const opened = conn;
    if (!opened || closed) return;
    opened
      .then((x) => x.leaseKeepalive())
      .catch((err: unknown) => {
        // A lost keepalive only risks the lease's keepalive_lost end; say so once, not every 30 s.
        if (warned || closed) return;
        warned = true;
        const why =
          err instanceof LeaseControlError
            ? `(${err.code}): ${err.message}`
            : `: ${err instanceof Error ? err.message : String(err)}`;
        c.io.err(
          `sbx mcp: lease keepalive failed ${sanitizeRemote(why)}; further failures are not logged`,
        );
      });
  };
  const onToken = (t: SbxToken) => {
    tokenMode = jwtMode(t.token);
    leased = tokenMode !== 'per-exec';
    if (!leased) stopBeat();
    else if (!beat && !closed) beat = setInterval(keepalive, KEEPALIVE_MS);
  };
  const open = () =>
    (conn ??= openExec(c.api, id, factory, {
      sandboxExpiresAt: s.expiresAt,
      onToken,
      keepalive: () => leased,
    }).catch((err: unknown) => {
      conn = undefined; // the next call asks again; this one fails as it is
      throw err;
    }));
  const exec: Exec = async (command, opts) => (await open()).exec(command, opts);
  // The tool call's cancel signal reaches the lease call: a cancelled `reset` stops waiting.
  const lease: LeaseCall = async (op, opts) => (await open()).leaseControl(op, undefined, opts);
  const info = async () => {
    const now = await c.api.getSandbox(id);
    const current = recordMode(now);
    const calls =
      current === 'per-exec' ? 'every call is a fresh VM, so no process survives it' : LEASE_RULE;
    return {
      text:
        `Sandbox ${now.id}${now.name ? ` (${now.name})` : ''}: template ${now.template}, ${now.state}, expires ` +
        `${new Date(now.expiresAt * 1000).toISOString()}. Files live under /workspace and persist; ${calls}; ` +
        'there is no network; calls run one at a time.',
      mode: current,
    };
  };
  const server = createSandboxMcpServer({
    exec,
    info,
    lease,
    mode,
    leaseMode: () => tokenMode,
    record: (r) => recordCall(c.rt.paths.stateDir, id, r),
    expiresAt: s.expiresAt,
    version: VERSION,
  });
  const stop = () => void server.close().catch(() => {});
  try {
    await new Promise<void>((resolve, reject) => {
      // Protocol.onclose is the SDK's own close hook; the transport's callbacks belong to the SDK.
      server.onclose = () => resolve();
      server.connect(transport).catch(reject);
      if (c.signal?.aborted) stop();
      else c.signal?.addEventListener('abort', stop, { once: true });
    });
  } finally {
    closed = true;
    stopBeat();
    c.signal?.removeEventListener('abort', stop);
    if (conn) (await conn.catch(() => undefined))?.close();
  }
}
