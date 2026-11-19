import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SBX_ABOUT, SBX_USAGE } from '../src/sbx/cli.js';

/**
 * docs/sandbox/reference/cli-sbx.md carries `mocactl sbx --help` (SBX_ABOUT, then SBX_USAGE)
 * between two markers, so the published reference cannot drift from the CLI. Run with
 * UPDATE_SBX_REFERENCE=1 to rewrite the block after changing the help text.
 */
const PAGE = fileURLToPath(new URL('../../../docs/sandbox/reference/cli-sbx.md', import.meta.url));
const BEGIN = '<!-- BEGIN GENERATED: mocactl sbx --help -->';
const END = '<!-- END GENERATED: mocactl sbx --help -->';

function block(): string {
  // A backtick fence, as Prettier writes one (it rewrites a tilde fence): the help text quotes
  // commands in single backticks, never three at the start of a line (the second test).
  return `${BEGIN}\n\n\`\`\`text\n${SBX_ABOUT}\n\n${SBX_USAGE}\n\`\`\`\n\n${END}`;
}

describe('the mocactl sbx reference page', () => {
  it('carries the CLI help text verbatim', () => {
    const page = readFileSync(PAGE, 'utf8');
    const start = page.indexOf(BEGIN);
    const end = page.indexOf(END);
    expect(start, `${PAGE} has no ${BEGIN} marker`).toBeGreaterThanOrEqual(0);
    expect(end, `${PAGE} has no ${END} marker after its BEGIN`).toBeGreaterThan(start);
    const current = page.slice(start, end + END.length);
    if (process.env.UPDATE_SBX_REFERENCE === '1' && current !== block()) {
      writeFileSync(PAGE, page.slice(0, start) + block() + page.slice(end + END.length));
      return;
    }
    expect(
      current,
      'regenerate it: UPDATE_SBX_REFERENCE=1 pnpm -C packages/mocactl exec vitest run test/sbx-reference.test.ts',
    ).toBe(block());
  });

  it('keeps the help text free of a fence that would end the block early', () => {
    expect(`${SBX_ABOUT}\n${SBX_USAGE}`).not.toMatch(/^\s*```/m);
  });
});
