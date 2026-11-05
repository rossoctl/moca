import { isAbsolute, resolve as resolvePath } from 'node:path';
import { createGrepTool } from '@earendil-works/pi-coding-agent';
import type { SandboxContext } from './transport.js';
import type { ExecInPod } from './transport.js';
import { mapPath, shQuote } from './paths.js';

/**
 * grep cannot be routed via GrepOperations because Pi's grep always spawns a
 * LOCAL `rg` (see NOTES-pi-operations.md). We reuse the built-in tool's schema,
 * label, and render, but replace `execute` to run `rg` IN the pod and return
 * grep's result shape: { content: [{ type: "text", text }], details: undefined }.
 */
export function createPodGrepTool(
  localCwd: string,
  exec: ExecInPod,
  cfg: SandboxContext,
): ReturnType<typeof createGrepTool> {
  const base = createGrepTool(localCwd);
  return {
    ...base,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const pattern = String(params.pattern ?? '');
      const searchDir = typeof params.path === 'string' ? params.path : '.';
      const glob = typeof params.glob === 'string' ? params.glob : undefined;
      const ignoreCase = params.ignoreCase === true;
      const literal = params.literal === true;
      const context = typeof params.context === 'number' ? params.context : 0;

      const headPath = isAbsolute(searchDir) ? searchDir : resolvePath(localCwd, searchDir);
      const podPath = mapPath(headPath, cfg.headCwd, cfg.podCwd);

      const parts = ['rg', '--line-number', '--no-heading', '--color=never', '--hidden'];
      if (ignoreCase) parts.push('--ignore-case');
      if (literal) parts.push('--fixed-strings');
      if (context > 0) parts.push('--context', String(context));
      if (glob) parts.push('--glob', shQuote(glob));
      parts.push('--', shQuote(pattern), shQuote(podPath));

      const streamed: Buffer[] = [];
      const r = await exec(parts.join(' '), {
        signal,
        onData: (chunk) => streamed.push(chunk),
      });
      if (r.truncated) {
        throw new Error(
          `grep output exceeded the sandbox output cap and was cut short. ` +
            `Narrow the pattern or search a smaller path.`,
        );
      }
      if (r.exitCode !== 0 && r.exitCode !== 1) {
        const detail = Buffer.concat(streamed).toString().trim();
        throw new Error(`rg failed in pod (exit ${r.exitCode})${detail ? `: ${detail}` : ''}`);
      }
      const text = r.stdout.toString();
      // rg exits 1 with no output when there are no matches.
      if (r.exitCode === 1 && text.trim() === '') {
        return {
          content: [{ type: 'text' as const, text: 'No matches found' }],
          details: undefined,
        };
      }
      return {
        content: [{ type: 'text' as const, text: text.length ? text : 'No matches found' }],
        details: undefined,
      };
    },
  } as ReturnType<typeof createGrepTool>;
}
