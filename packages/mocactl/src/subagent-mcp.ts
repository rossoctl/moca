/**
 * `mocactl mcp` (#396, B11): the subagent commands as MCP tools, so a coding agent dispatches and
 * collects subagents through structured calls instead of parsing this CLI's output.
 *
 * Every tool is a thin adapter over the command of the same name: the command runs with
 * `json: true` and an `Io` that captures its two streams, and the JSON line it prints IS the tool's
 * result. Nothing about dispatch, the ledger or the result files lives here, so the agent and a
 * human at a terminal cannot drift apart, and each command's own tests cover the behaviour.
 *
 * Results stay small by construction rather than by truncation: `get` and `follow_up` write the
 * reply, the patch and the verdict to FILES and report their paths, so a 4 MiB patch never reaches
 * the agent's context. `list` is the one unbounded answer, and is capped here.
 *
 * No waiting tool, deliberately: a blocking call holds the agent's turn and runs into the client's
 * tool timeout. `mocactl watch` run as a background command is how a subagent is followed to its
 * end; `get` is a single read.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describeError } from './core/messages.js';
import type { Io } from './headless.js';
import type { Runtime } from './runtime.js';
import { cmdCancel, cmdDecide, cmdFollowUp, cmdGet, cmdSpawn, cmdSubagents } from './subagent.js';
import { VERSION } from './version.js';

/**
 * Rows one `list` answers with. The ledger is append-only and never pruned, so a long-running agent
 * would otherwise grow this result until it crowded out its own context. The newest rows are kept
 * (the ledger reads oldest-first) and the rest reported as a count.
 */
const LIST_MAX = 50;

/**
 * A result body's ceiling. Every shape here is small by design, so this catches only the case the
 * design cannot bound: an operator who raised `MOCA_TURN_SUMMARY_BYTES` far enough that a gate
 * summary alone would flood the agent. ~24 KiB is well inside the 10k-token budget #396 asks for.
 */
const MAX_RESULT_BYTES = 24 * 1024;

/** What the server tells the client once, on connecting. */
const INSTRUCTIONS = `Dispatch and collect moca subagents: cloud sessions that run a prompt on their own.

- spawn returns as soon as the subagent is dispatched; it does NOT wait for the answer.
- get reads the result once. A status of queued or running means "not finished yet" -- call it
  again later. It writes the reply, any patch and any verdict to files and reports their PATHS,
  so read the file you need instead of expecting the bytes here.
- There is no waiting tool: run \`mocactl watch\` as a background shell command if you want to be
  told when a subagent finishes.
- A subagent spawned with require_approval parks at a gate and does nothing until approve or
  reject answers it; get reports the gate and its id.
- Only a subagent spawned with async can be cancelled.`;

const TOOLS: Tool[] = [
  {
    name: 'spawn',
    description:
      'Dispatch a subagent to run a prompt on its own session, and return its session id. Does ' +
      'not wait for the result; use get to collect it.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What the subagent should do. The whole task: it cannot ask questions.',
        },
        kind: {
          type: 'string',
          enum: ['prompt', 'solve'],
          description:
            "'prompt' (default) answers the prompt; 'solve' works on a repository and needs " +
            'repo_url and ref, and its result is a patch.',
        },
        repo_url: { type: 'string', description: "The repository to work on ('solve' only)." },
        ref: { type: 'string', description: "The branch or commit to start from ('solve' only)." },
        tag: {
          type: 'string',
          description: 'A label shared by a batch of subagents, to list or watch them together.',
        },
        label: { type: 'string', description: 'A note about this one subagent, shown by list.' },
        config: {
          type: 'string',
          description: 'A promoted config bundle to run under, as its sha256:… digest.',
        },
        require_approval: {
          type: 'boolean',
          description:
            'Park the subagent at a gate before it acts, for approve or reject to answer.',
        },
        async: {
          type: 'boolean',
          description:
            'Dispatch as a server-side turn, which can be cancelled and needs no local process. ' +
            'The deployment must have its async drain enabled, or the subagent waits in the queue.',
        },
        max_concurrent: {
          type: 'integer',
          description:
            'Refuse this dispatch when that many subagents of yours are still running. Use it to ' +
            'bound a fan-out.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list',
    description: 'Your subagents and the state of each, newest last.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Only the subagents spawned with this tag.' },
      },
    },
  },
  {
    name: 'get',
    description:
      "One read of a subagent's result. Writes the reply, any patch and any verdict to files and " +
      'reports their paths. A queued or running status means it has not finished yet.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session id spawn returned.' },
        out_dir: {
          type: 'string',
          description: 'Where to write the result files. Defaults to the current directory.',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'follow_up',
    description:
      "A second prompt on a finished subagent's session, which keeps the first turn's context. " +
      'Copies the previous result to files first.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session id spawn returned.' },
        prompt: { type: 'string', description: "The next turn's prompt." },
        out_dir: {
          type: 'string',
          description: 'Where the previous result is copied. Defaults to the current directory.',
        },
      },
      required: ['session_id', 'prompt'],
    },
  },
  {
    name: 'approve',
    description: 'Let a subagent parked at a gate carry on with what it proposed.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session id spawn returned.' },
        gate: {
          type: 'integer',
          description: 'The gate id, when get could not be read. Otherwise it is read for you.',
        },
        feedback: {
          type: 'string',
          description: 'Reaches the model verbatim as part of the resumed turn.',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'reject',
    description:
      'Refuse what a subagent parked at a gate proposed; it carries on with your feedback instead.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session id spawn returned.' },
        gate: {
          type: 'integer',
          description: 'The gate id, when get could not be read. Otherwise it is read for you.',
        },
        feedback: {
          type: 'string',
          description: 'Why, and what to do instead. Reaches the model verbatim.',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'cancel',
    description:
      'Stop a subagent spawned with async. A queued one never starts; a running one is asked to ' +
      'stop, and get reports how it ended.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session id spawn returned.' },
      },
      required: ['session_id'],
    },
  },
];

/** The commands the tools run. Injected whole in tests; the defaults are the real ones. */
export interface SubagentCmds {
  spawn: typeof cmdSpawn;
  list: typeof cmdSubagents;
  get: typeof cmdGet;
  decide: typeof cmdDecide;
  followUp: typeof cmdFollowUp;
  cancel: typeof cmdCancel;
}

const REAL: SubagentCmds = {
  spawn: cmdSpawn,
  list: cmdSubagents,
  get: cmdGet,
  decide: cmdDecide,
  followUp: cmdFollowUp,
  cancel: cmdCancel,
};

const fail = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/** A non-empty string argument, or undefined: the client is an LLM, so nothing is assumed. */
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) ? v : undefined;

/**
 * Run one command and turn its two streams into a tool result.
 *
 * The exit code is NOT the verdict: `get` exits 1 on a subagent that is merely still running, and
 * that is an answer, not an error. What decides is the JSON line — a command prints one on stdout
 * exactly when it has an answer, and prints only to stderr when it has refused. So a parsed line
 * is the result and an empty stdout is the error, with the command's own message as its text.
 */
async function call(
  name: string,
  run: (io: Io) => Promise<number>,
  shape?: (body: Record<string, unknown>) => Record<string, unknown>,
): Promise<CallToolResult> {
  let stdout = '';
  const stderr: string[] = [];
  const io: Io = {
    out: (s) => {
      stdout += s;
    },
    err: (s) => {
      stderr.push(s);
    },
  };
  let code: number;
  try {
    code = await run(io);
  } catch (err) {
    // A command that threw rather than reported: its message is all there is to say.
    return fail(describeError(err));
  }
  const line = stdout.trim();
  if (!line.startsWith('{')) {
    return fail(stderr.join('\n') || `${name} failed (exit ${code})`);
  }
  let text = line;
  if (shape) {
    let body: unknown;
    try {
      body = JSON.parse(line);
    } catch {
      return fail(`${name}: unreadable result`);
    }
    text = JSON.stringify(shape(body as Record<string, unknown>));
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) {
    return fail(
      `${name}: the result is larger than ${MAX_RESULT_BYTES} bytes, which is more than this ` +
        'tool will return; run the command itself to see it',
    );
  }
  return { content: [{ type: 'text', text }] };
}

/** `list`'s newest rows, with what was left out named rather than silently dropped. */
function capRows(body: Record<string, unknown>): Record<string, unknown> {
  const rows = body.subagents;
  if (!Array.isArray(rows) || rows.length <= LIST_MAX) return body;
  return { ...body, subagents: rows.slice(-LIST_MAX), omitted: rows.length - LIST_MAX };
}

/**
 * The subagent MCP server: the tool list and the one call handler. Separate from `serveSubagentMcp`
 * so tests can drive it over an in-memory transport.
 */
export function createSubagentMcpServer(rt: Runtime, cmds: Partial<SubagentCmds> = {}): Server {
  const c: SubagentCmds = { ...REAL, ...cmds };
  const server = new Server(
    { name: 'moca-subagents', version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const a = (req.params.arguments ?? {}) as Record<string, unknown>;
    // Not validated here beyond its type: every command checks the id itself and reports the same
    // message a human would see, so a second copy of that check could only disagree with it.
    const sessionId = str(a.session_id) ?? '';
    const signal = extra.signal;
    const name = req.params.name;
    switch (name) {
      case 'spawn':
        return call(name, (io) =>
          c.spawn(rt, io, {
            prompt: str(a.prompt) ?? '',
            kind: a.kind === 'solve' ? 'solve' : 'prompt',
            repoUrl: str(a.repo_url),
            ref: str(a.ref),
            tag: str(a.tag),
            label: str(a.label),
            configRef: str(a.config),
            requireApproval: a.require_approval === true,
            async: a.async === true,
            maxConcurrent: int(a.max_concurrent),
            json: true,
          }),
        );
      case 'list':
        return call(name, (io) => c.list(rt, io, { tag: str(a.tag), json: true, signal }), capRows);
      case 'get':
        return call(name, (io) =>
          c.get(rt, io, { sessionId, outDir: str(a.out_dir), json: true, signal }),
        );
      case 'follow_up':
        return call(name, (io) =>
          c.followUp(rt, io, {
            sessionId,
            prompt: str(a.prompt) ?? '',
            outDir: str(a.out_dir),
            json: true,
            signal,
          }),
        );
      case 'approve':
      case 'reject':
        return call(name, (io) =>
          c.decide(rt, io, {
            sessionId,
            action: name,
            gateId: int(a.gate),
            feedback: str(a.feedback),
            json: true,
            signal,
          }),
        );
      case 'cancel':
        return call(name, (io) => c.cancel(rt, io, { sessionId, json: true }));
      default:
        return fail(`unknown tool '${name}'`);
    }
  });
  return server;
}

/**
 * Serve the subagent tools on the given transport (stdio in production). Resolves when the
 * transport closes or `signal` aborts. Writes nothing to stdout itself — the transport owns it.
 */
export async function serveSubagentMcp(
  rt: Runtime,
  transport: Transport,
  opts: { signal?: AbortSignal; cmds?: Partial<SubagentCmds> } = {},
): Promise<void> {
  const server = createSubagentMcpServer(rt, opts.cmds);
  const stop = () => void server.close().catch(() => {});
  try {
    await new Promise<void>((resolve, reject) => {
      // Protocol.onclose is the SDK's own close hook; the transport's callbacks belong to the SDK.
      server.onclose = () => resolve();
      server.connect(transport).catch(reject);
      if (opts.signal?.aborted) stop();
      else opts.signal?.addEventListener('abort', stop, { once: true });
    });
  } finally {
    opts.signal?.removeEventListener('abort', stop);
  }
}
