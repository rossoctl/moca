import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { BannerInfo } from '../src/core/banner.js';
import { Banner } from '../src/views/Banner.js';
import { DARK_TOKENS, SYSTEM_TOKENS, resolveTheme } from '../src/theme/tokens.js';
import { withTheme } from './helpers/ink.js';

const full: BannerInfo = {
  mocactlVersion: '0.5.2',
  cpVersion: '0.5.1',
  harnessVersion: '0.5.0',
  cwd: '~/work/moca',
};

describe('Banner', () => {
  it('stacks the logo, the three versions and the cwd, one per line', () => {
    const { lastFrame } = render(withTheme(<Banner info={full} />));
    const f = lastFrame()!;
    expect(f).toContain('mocactl 0.5.2');
    expect(f).toContain('control plane 0.5.1');
    expect(f).toContain('harness 0.5.0');
    expect(f).toContain('~/work/moca');
  });

  it('keeps the logo column aligned with the text column', () => {
    const { lastFrame } = render(withTheme(<Banner info={full} />));
    const lines = lastFrame()!.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines[0].trimEnd().startsWith('  ▄█▄')).toBe(true);
    expect(lines[1].trimEnd().startsWith(' ▞███▙]')).toBe(true);
    expect(lines[2].trimEnd().startsWith(' ▀███▀')).toBe(true);
    expect(lines[3].startsWith(' '.repeat(9))).toBe(true);
    // The bash banner leaves a blank line after itself.
    expect(lines[4].trim()).toBe('');
  });

  it('marks unknown versions with ?', () => {
    const { lastFrame } = render(
      withTheme(<Banner info={{ mocactlVersion: '0.5.2', cwd: '/tmp' }} />),
    );
    const f = lastFrame()!;
    expect(f).toContain('control plane ?');
    expect(f).toContain('harness ?');
  });

  it('colors the logo pure red, through the theme token', () => {
    // ink-testing-library's stdout is not a TTY, so frames carry no ANSI — the color itself is
    // unobservable here. Assert the token the component routes through instead: pure TrueColor
    // red in both palettes, and gone under NO_COLOR like every other token.
    expect(SYSTEM_TOKENS.logo).toBe('#ff0000');
    expect(DARK_TOKENS.logo).toBe('#ff0000');
    expect(resolveTheme('system', { NO_COLOR: '1' }, true).tokens.logo).toBeUndefined();
  });
});
