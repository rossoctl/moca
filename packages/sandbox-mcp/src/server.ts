import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ExecInPod } from '@moca/k8s-sandbox';
import { buildTools, WORKSPACE } from './tools.js';

/** One line per tool call or transfer: the measurement this spike exists for. */
export interface CallRecord {
  op: string;
  ms: number;
  execs: number;
  ok: boolean;
  error?: string;
  /** What the call acted on: the command, path or pattern, truncated. An audit trail, not a replay. */
  detail?: string;
}

/** The argument that says what a tool call did, one line, at most 80 characters. */
function detailOf(args: Record<string, unknown>): string | undefined {
  const v = args.command ?? args.path ?? args.pattern;
  if (typeof v !== 'string') return undefined;
  const line = v.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export type Logger = (rec: CallRecord) => void;

/** Wraps the exec seam so one tool call can count the Execs (VMs, on the microVM tier) it made. */
function counted(exec: ExecInPod): { exec: ExecInPod; count: () => number } {
  let n = 0;
  return {
    exec: (command, opts) => {
      n++;
      return exec(command, opts);
    },
    count: () => n,
  };
}

/** Tool schemas never depend on the exec seam, so list them once from a seam that is never called. */
const neverExec: ExecInPod = () => Promise.reject(new Error('unreachable'));

export function createMcpServer(exec: ExecInPod, log: Logger): Server {
  const server = new Server(
    { name: 'moca-sandbox', version: '0.0.0-spike' },
    {
      capabilities: { tools: {} },
      instructions:
        `Every tool runs in a remote sandbox whose working directory is ${WORKSPACE}. ` +
        'Each call runs in a fresh VM: no process survives between calls, so never start ' +
        'background jobs or servers expecting them to keep running. Files under ' +
        `${WORKSPACE} persist. The sandbox has no network access.`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildTools(neverExec).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as { type: 'object' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const c = counted(exec);
    const tool = buildTools(c.exec).find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
      };
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const detail = detailOf(args);
    const started = Date.now();
    try {
      const r = await tool.execute(`mcp-${String(extra.requestId)}`, args, extra.signal);
      log({ op: tool.name, ms: Date.now() - started, execs: c.count(), ok: true, detail });
      return { content: r.content as CallToolResult['content'] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log({
        op: tool.name,
        ms: Date.now() - started,
        execs: c.count(),
        ok: false,
        error: message,
        detail,
      });
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });

  return server;
}

/** Push replaces the workspace with a gzipped tar and commits it as the baseline that pull diffs. */
export const PUSH_COMMAND =
  `cd ${WORKSPACE} && find . -mindepth 1 -delete && ` +
  // The sandbox runtime image ships python3 and git but not tar/gzip.
  `if command -v tar >/dev/null && command -v gzip >/dev/null; then tar -xzf - ; else ` +
  `python3 -c 'import sys,tarfile; tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz").extractall(".")'; fi && ` +
  `git init -q && ` +
  // Build output a repo forgot to .gitignore must not come back in the pull patch (SBX1 O12).
  `printf '%s\\n' __pycache__/ '*.pyc' node_modules/ .venv/ venv/ .pytest_cache/ .mypy_cache/ > .git/info/exclude && ` +
  `git add -A && ` +
  `git -c user.name=sbx -c user.email=sbx@localhost commit -q --no-verify -m sbx-baseline && ` +
  `git rev-parse --short HEAD && git ls-files | wc -l`;

/** Pull is every change since the baseline, untracked (non-ignored) files included. */
export const PULL_COMMAND = `cd ${WORKSPACE} && git add -A -N . && git diff --binary HEAD`;

/** The Exec message ceiling is 16 MiB; leave room for framing. */
export const MAX_PUSH_BYTES = 12 * 1024 * 1024;

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function reply(res: ServerResponse, status: number, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/** /mcp (stateless streamable HTTP), plus /push and /pull for the laptop scripts. */
export function createHandler(exec: ExecInPod, log: Logger) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (path === '/mcp') {
        // Stateless: a fresh server and transport per request, so nothing is shared between clients.
        const server = createMcpServer(exec, log);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }
      if (path === '/push' && req.method === 'POST') {
        const body = await readBody(req, MAX_PUSH_BYTES);
        if (!body) return reply(res, 413, `push exceeds ${MAX_PUSH_BYTES} bytes compressed\n`);
        return await transfer(res, log, 'push', () => exec(PUSH_COMMAND, { stdin: body }));
      }
      if (path === '/pull' && req.method === 'GET') {
        return await transfer(res, log, 'pull', () => exec(PULL_COMMAND));
      }
      if (path === '/healthz') return reply(res, 200, 'ok\n');
      reply(res, 404, 'not found\n');
    } catch (err) {
      if (!res.headersSent)
        reply(res, 500, `${err instanceof Error ? err.message : String(err)}\n`);
    }
  };
}

async function transfer(
  res: ServerResponse,
  log: Logger,
  op: string,
  run: () => ReturnType<ExecInPod>,
): Promise<void> {
  const started = Date.now();
  const r = await run();
  const ok = r.exitCode === 0 && !r.truncated;
  log({
    op,
    ms: Date.now() - started,
    execs: 1,
    ok,
    ...(ok ? {} : { error: `exit ${r.exitCode}` }),
  });
  if (ok) return reply(res, 200, r.stdout);
  reply(
    res,
    502,
    `${op} failed in the sandbox (exit ${r.exitCode}${r.truncated ? ', truncated' : ''})\n`,
  );
}
