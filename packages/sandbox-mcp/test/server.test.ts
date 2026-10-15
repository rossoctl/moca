import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ExecInPod } from '@moca/k8s-sandbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandler, type CallRecord } from '../src/server.js';

/** A local stand-in for the relay: `bash -c` with /workspace rewritten to a temp dir. */
function localExec(root: string): ExecInPod {
  return (command, opts = {}) =>
    new Promise((resolve, reject) => {
      const p = spawn('bash', ['-c', command.replaceAll('/workspace', root)], { cwd: root });
      const out: Buffer[] = [];
      p.stdout.on('data', (b: Buffer) => {
        out.push(b);
        opts.onData?.(b);
      });
      p.stderr.on('data', (b: Buffer) => opts.onData?.(b));
      p.on('error', reject);
      p.on('close', (code) =>
        resolve({ stdout: Buffer.concat(out), exitCode: code, truncated: false }),
      );
      p.stdin.end(opts.stdin ?? Buffer.alloc(0));
    });
}

let root: string;
let http: HttpServer;
let base: string;
let client: Client;
const records: CallRecord[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'sbx-mcp-'));
  http = createServer(createHandler(localExec(root), (r) => records.push(r)));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const addr = http.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});

afterAll(async () => {
  await client?.close();
  http?.close();
  rmSync(root, { recursive: true, force: true });
});

const text = (r: Awaited<ReturnType<Client['callTool']>>) =>
  (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');

describe('sandbox-mcp', () => {
  it('lists Pi’s seven tools with their schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'bash',
      'edit',
      'find',
      'grep',
      'ls',
      'read',
      'write',
    ]);
    expect(tools.find((t) => t.name === 'read')?.inputSchema.properties).toHaveProperty('path');
  });

  it('pushes a tree, works on it through the tools, and pulls a patch', async () => {
    const src = mkdtempSync(join(tmpdir(), 'sbx-src-'));
    await promisify(execFile)('bash', [
      '-c',
      `cd ${src} && printf 'hello world\\n' > a.txt && mkdir sub && printf 'needle\\n' > sub/b.txt`,
    ]);
    const tgz = (
      await promisify(execFile)('tar', ['-czf', '-', '-C', src, '.'], {
        encoding: 'buffer',
      })
    ).stdout as Buffer;
    const push = await fetch(`${base}/push`, { method: 'POST', body: new Uint8Array(tgz) });
    expect(push.status, await push.clone().text()).toBe(200);

    expect(text(await client.callTool({ name: 'read', arguments: { path: 'a.txt' } }))).toContain(
      'hello world',
    );
    const edit = await client.callTool({
      name: 'edit',
      arguments: { path: 'a.txt', edits: [{ oldText: 'world', newText: 'sandbox' }] },
    });
    expect(edit.isError, text(edit)).toBeFalsy();
    await client.callTool({ name: 'write', arguments: { path: 'new.txt', content: 'fresh\n' } });
    expect(
      text(await client.callTool({ name: 'grep', arguments: { pattern: 'needle' } })),
    ).toContain('sub/b.txt');
    expect(
      text(await client.callTool({ name: 'find', arguments: { pattern: '*.txt' } })),
    ).toContain('new.txt');
    expect(text(await client.callTool({ name: 'ls', arguments: {} }))).toContain('sub/');
    expect(text(await client.callTool({ name: 'bash', arguments: { command: 'pwd' } }))).toContain(
      root,
    );

    await client.callTool({
      name: 'bash',
      arguments: { command: 'mkdir -p __pycache__ && echo x > __pycache__/m.pyc' },
    });
    const patch = await (await fetch(`${base}/pull`)).text();
    expect(patch).toContain('+hello sandbox');
    expect(patch).toContain('new.txt');
    expect(patch).not.toContain('__pycache__');
    rmSync(src, { recursive: true, force: true });
  });

  it('returns a failing command as a tool error, not a transport error', async () => {
    const r = await client.callTool({ name: 'bash', arguments: { command: 'exit 3' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/code 3/);
  });

  it('spends one Exec (one VM on the microVM tier) per call, two for edit', () => {
    const execs = (op: string) => records.find((r) => r.op === op && r.ok)?.execs;
    expect({
      read: execs('read'),
      write: execs('write'),
      edit: execs('edit'),
      ls: execs('ls'),
      find: execs('find'),
      grep: execs('grep'),
      bash: execs('bash'),
    }).toEqual({ read: 1, write: 1, edit: 2, ls: 1, find: 1, grep: 1, bash: 1 });
  });

  it('writes into a directory that does not exist yet, and ls marks directories', async () => {
    const w = await client.callTool({
      name: 'write',
      arguments: { path: 'deep/er/f.txt', content: 'x\n' },
    });
    expect(w.isError, text(w)).toBeFalsy();
    expect(text(await client.callTool({ name: 'ls', arguments: { path: 'deep' } }))).toContain(
      'er/',
    );
    const missing = await client.callTool({ name: 'ls', arguments: { path: 'nope' } });
    expect(missing.isError).toBe(true);
  });

  it('logs what each call acted on, one line, truncated', () => {
    expect(records.find((r) => r.op === 'read')?.detail).toBe('a.txt');
    expect(records.find((r) => r.op === 'grep')?.detail).toBe('needle');
    const long = records.find((r) => r.op === 'bash' && r.detail?.startsWith('mkdir'));
    expect(long?.detail).toBe('mkdir -p __pycache__ && echo x > __pycache__/m.pyc');
  });

  it('reports a missing file as a tool error', async () => {
    const r = await client.callTool({ name: 'read', arguments: { path: 'nope.txt' } });
    expect(r.isError).toBe(true);
  });
});
