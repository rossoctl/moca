import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Io } from '../src/headless.js';
import type { Runtime } from '../src/runtime.js';
import { createSubagentMcpServer, type SubagentCmds } from '../src/subagent-mcp.js';

/** A command that answers with one JSON line, as every `--json` command does. */
const answers = (body: unknown, code = 0) =>
  vi.fn(async (_rt: Runtime, io: Io) => {
    io.out(JSON.stringify(body) + '\n');
    return code;
  });

/** A command that refuses: a message on stderr, nothing on stdout. */
const refuses = (message: string, code = 1) =>
  vi.fn(async (_rt: Runtime, io: Io) => {
    io.err(message);
    return code;
  });

const rt = {} as Runtime;
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function connect(cmds: Partial<SubagentCmds> = {}) {
  const server = createSubagentMcpServer(rt, cmds);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  closers.push(() => client.close());
  return client;
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args }) as Promise<Res>;
const body = (r: Res) => JSON.parse(r.content.map((x) => x.text).join(''));
/** The options the adapter passed the command. */
const optsOf = (cmd: unknown) => (cmd as { mock: { calls: unknown[][] } }).mock.calls[0]![2];

describe('the subagent MCP server (#396)', () => {
  it('lists the seven tools, and no waiting one', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'approve',
      'cancel',
      'follow_up',
      'get',
      'list',
      'reject',
      'spawn',
    ]);
    // Every tool but spawn and list acts on one subagent, so its id is required.
    expect(tools.find((t) => t.name === 'get')!.inputSchema.required).toEqual(['session_id']);
    expect(tools.find((t) => t.name === 'spawn')!.inputSchema.required).toEqual(['prompt']);
  });

  it('spawn translates the snake_case arguments the schema declares', async () => {
    const spawn = answers({ type: 'session', sessionId: 's1', turnId: 't1' });
    const client = await connect({ spawn });
    const r = await call(client, 'spawn', {
      prompt: 'do it',
      kind: 'solve',
      repo_url: 'https://git.test/r',
      ref: 'main',
      require_approval: true,
      async: true,
      max_concurrent: 2,
      config: 'sha256:abc',
    });
    expect(body(r)).toEqual({ type: 'session', sessionId: 's1', turnId: 't1' });
    expect(optsOf(spawn)).toMatchObject({
      prompt: 'do it',
      kind: 'solve',
      repoUrl: 'https://git.test/r',
      ref: 'main',
      requireApproval: true,
      async: true,
      maxConcurrent: 2,
      configRef: 'sha256:abc',
      json: true,
    });
  });

  it('an unfinished subagent is an answer, not an error, though get exits 1', async () => {
    const client = await connect({ get: answers({ sessionId: 's1', status: 'queued' }, 1) });
    const r = await call(client, 'get', { session_id: 's1' });
    expect(r.isError).toBeFalsy();
    expect(body(r)).toEqual({ sessionId: 's1', status: 'queued' });
  });

  it("a command's refusal is the tool's error, with its own message", async () => {
    const client = await connect({ get: refuses("no ledger row for 'nope'") });
    const r = await call(client, 'get', { session_id: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('no ledger row');
  });

  it('reports a result that only names files, never the bytes', async () => {
    const get = answers({ sessionId: 's1', status: 'responded', files: ['/tmp/s1.text'] });
    const client = await connect({ get });
    const r = await call(client, 'get', { session_id: 's1', out_dir: '/tmp' });
    expect(body(r).files).toEqual(['/tmp/s1.text']);
    expect(optsOf(get)).toMatchObject({ sessionId: 's1', outDir: '/tmp', json: true });
  });

  it('approve and reject are one command, told apart by the action', async () => {
    const decide = answers({ sessionId: 's1', gateId: 0, action: 'reject' });
    const client = await connect({ decide });
    await call(client, 'reject', { session_id: 's1', gate: 0, feedback: 'not that' });
    expect(optsOf(decide)).toMatchObject({
      sessionId: 's1',
      action: 'reject',
      gateId: 0,
      feedback: 'not that',
    });
  });

  it('caps a long list at its newest rows and says how many it left out', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ sessionId: `s${i}` }));
    const client = await connect({ list: answers({ subagents: rows }) });
    const r = await call(client, 'list');
    const got = body(r);
    expect(got.subagents).toHaveLength(50);
    expect(got.subagents[49]).toEqual({ sessionId: 's59' });
    expect(got.omitted).toBe(10);
  });

  it('a short list is passed through untouched', async () => {
    const client = await connect({ list: answers({ subagents: [{ sessionId: 's0' }] }) });
    expect(body(await call(client, 'list'))).toEqual({ subagents: [{ sessionId: 's0' }] });
  });

  it('refuses a result too large to return instead of flooding the agent', async () => {
    const huge = { sessionId: 's1', status: 'paused', gate: { summary: 'x'.repeat(30_000) } };
    const client = await connect({ get: answers(huge) });
    const r = await call(client, 'get', { session_id: 's1' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('larger than');
  });

  it('a command that throws is reported, not propagated as a protocol error', async () => {
    const client = await connect({
      cancel: vi.fn(async () => {
        throw new Error('redis is down');
      }) as unknown as SubagentCmds['cancel'],
    });
    const r = await call(client, 'cancel', { session_id: 's1' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('redis is down');
  });
});
