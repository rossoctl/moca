import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { USAGE } from '../src/cli.js';

/**
 * docs/harness/reference/cli-mocactl.md carries `mocactl --help` (USAGE) between two markers, so
 * the published reference cannot drift from the CLI. Run with UPDATE_MOCACTL_REFERENCE=1 to
 * rewrite the block after changing the help text. Its sbx twin is sbx-reference.test.ts.
 */
const PAGE = fileURLToPath(
  new URL('../../../docs/harness/reference/cli-mocactl.md', import.meta.url),
);
const BEGIN = '<!-- BEGIN GENERATED: mocactl --help -->';
const END = '<!-- END GENERATED: mocactl --help -->';

function block(): string {
  // A backtick fence, as Prettier writes one: the help text never starts a line with three
  // backticks (the second test).
  return `${BEGIN}\n\n\`\`\`text\n${USAGE}\n\`\`\`\n\n${END}`;
}

describe('the mocactl reference page', () => {
  it('carries the CLI help text verbatim', () => {
    const page = readFileSync(PAGE, 'utf8');
    const start = page.indexOf(BEGIN);
    const end = page.indexOf(END);
    expect(start, `${PAGE} has no ${BEGIN} marker`).toBeGreaterThanOrEqual(0);
    expect(end, `${PAGE} has no ${END} marker after its BEGIN`).toBeGreaterThan(start);
    const current = page.slice(start, end + END.length);
    if (process.env.UPDATE_MOCACTL_REFERENCE === '1' && current !== block()) {
      writeFileSync(PAGE, page.slice(0, start) + block() + page.slice(end + END.length));
      return;
    }
    expect(
      current,
      'regenerate it: UPDATE_MOCACTL_REFERENCE=1 pnpm -C packages/mocactl exec vitest run test/mocactl-reference.test.ts',
    ).toBe(block());
  });

  it('keeps the help text free of a fence that would end the block early', () => {
    expect(USAGE).not.toMatch(/^\s*```/m);
  });
});
