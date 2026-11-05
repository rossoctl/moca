import { describe, expect, it } from 'vitest';
import type { ExecInPod } from '../src/transport.js';
import type { SandboxContext } from '../src/transport.js';
import { createPodGrepTool } from '../src/grep-tool.js';

const cfg: SandboxContext = {
  podCwd: '/workspace',
  headCwd: '/head',
};

/** Build a fake ExecInPod that returns a scripted result and records calls. */
function fakeExec(result: { stdout?: string; exitCode?: number | null; truncated?: boolean }) {
  const calls: string[] = [];
  const fn: ExecInPod = async (command) => {
    calls.push(command);
    const exitCode = result.exitCode === undefined ? 0 : result.exitCode;
    return {
      stdout: Buffer.from(result.stdout ?? ''),
      exitCode,
      truncated: result.truncated ?? false,
    };
  };
  return { fn, calls };
}

describe('createPodGrepTool', () => {
  it('runs rg in the pod against the mapped path and returns match text', async () => {
    const { fn, calls } = fakeExec({ stdout: 'a.ts:1:hit' });
    const tool = createPodGrepTool('/head', fn, cfg);
    const result = await tool.execute('t1', { pattern: 'x', path: '/head' });
    expect(calls[0]).toContain('rg');
    expect(calls[0]).toContain("'/workspace'");
    expect((result as { content: Array<{ text: string }> }).content[0].text).toBe('a.ts:1:hit');
  });

  it('reports a cap trip as truncation, not as an rg failure', async () => {
    // Today truncation lands in the `exitCode !== 0 && !== 1` branch and surfaces as
    // "rg failed in pod (exit null)", which blames ripgrep for our own cap.
    const { fn } = fakeExec({ stdout: 'a.ts:1:hit', exitCode: null, truncated: true });
    const tool = createPodGrepTool('/head', fn, cfg);
    await expect(tool.execute('t1', { pattern: 'x', path: '/head' })).rejects.toThrow(/output cap/);
  });

  it('still reports a genuine rg failure distinctly from a cap trip', async () => {
    const { fn } = fakeExec({ stdout: '', exitCode: 2, truncated: false });
    const tool = createPodGrepTool('/head', fn, cfg);
    const err = (await tool
      .execute('t1', { pattern: '[', path: '/head' })
      .catch((e) => e)) as Error;
    expect(err.message).toMatch(/rg failed in pod/);
    expect(err.message).not.toMatch(/output cap/);
  });

  it("returns 'No matches found' on exit 1 with empty output", async () => {
    const { fn } = fakeExec({ stdout: '', exitCode: 1, truncated: false });
    const tool = createPodGrepTool('/head', fn, cfg);
    const result = await tool.execute('t1', { pattern: 'nope', path: '/head' });
    expect((result as { content: Array<{ text: string }> }).content[0].text).toBe(
      'No matches found',
    );
  });
});
