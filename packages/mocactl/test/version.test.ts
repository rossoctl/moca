import { describe, expect, it } from 'vitest';
import { versionLine } from '../src/version.js';

/** A fake git: answers by subcommand, or throws for one it was not given. */
const git =
  (answers: Record<string, string | Error>) =>
  (args: string[]): string => {
    const a = answers[args[0]!];
    if (a === undefined || a instanceof Error) throw a ?? new Error(`unexpected git ${args[0]}`);
    return a;
  };

describe('versionLine', () => {
  it('prints a built version as baked in, asking git nothing', () => {
    expect(versionLine('v1.2.3', git({}))).toBe('v1.2.3');
    expect(versionLine('edge-abc1234', git({}))).toBe('edge-abc1234');
  });

  it('names the commit of a clean source checkout', () => {
    expect(versionLine('dev', git({ 'rev-parse': '1e04a63d\n', status: '' }))).toBe('dev-1e04a63d');
  });

  it('marks a checkout whose tracked files differ from the commit', () => {
    expect(versionLine('dev', git({ 'rev-parse': '1e04a63d\n', status: ' M src/cli.ts\n' }))).toBe(
      'dev-1e04a63d-dirty',
    );
  });

  it('falls back to dev when git fails or is not a checkout', () => {
    expect(versionLine('dev', git({ 'rev-parse': new Error('not a git repository') }))).toBe('dev');
    expect(
      versionLine('dev', git({ 'rev-parse': '1e04a63d\n', status: new Error('timed out') })),
    ).toBe('dev');
  });

  it('falls back to dev on an answer that is not a commit id', () => {
    expect(versionLine('dev', git({ 'rev-parse': 'HEAD\n', status: '' }))).toBe('dev');
  });
});
