import { describe, expect, it } from 'vitest';
import { afterText, lifetimeText, parseLifetime, relativeText } from '../src/sbx/lifetime.js';

describe('parseLifetime (#770)', () => {
  it('reads minutes, hours, days and whole seconds', () => {
    expect(parseLifetime('14d')).toBe(1_209_600);
    expect(parseLifetime('36h')).toBe(129_600);
    expect(parseLifetime('30m')).toBe(1800);
    expect(parseLifetime('3600')).toBe(3600);
  });
  it.each(['', '0', '1.5d', '-1d', '7 d', '1w', '1e3', '99999999999999999999'])(
    'refuses %j',
    (raw) => {
      expect(parseLifetime(raw)).toBeUndefined();
    },
  );
});

describe('lifetimeText (#770)', () => {
  it('picks the largest exact unit', () => {
    expect(lifetimeText(604_800)).toBe('7 d');
    expect(lifetimeText(129_600)).toBe('36 h');
    expect(lifetimeText(5400)).toBe('90 min');
    expect(lifetimeText(3601)).toBe('3601 s');
  });
});

describe('afterText (#770)', () => {
  it('says a valid lifetime', () => {
    expect(afterText({ idleLifetimeS: 604_800 })).toBe(', after 7 d without use');
    expect(afterText({})).toBe('');
  });
  it.each([0, -1, 1.5, Number.NaN, '604800'])('prints nothing for %j', (v) => {
    expect(afterText({ idleLifetimeS: v as number })).toBe('');
  });
});

describe('relativeText', () => {
  const NOW = 1_800_000_000;
  it.each([
    [0, 'in <1 min'],
    [59, 'in <1 min'],
    [60, 'in 1 min'],
    [3599, 'in 59 min'],
    [3600, 'in 1 h'],
    [86_399, 'in 23 h'],
    [86_400, 'in 1 d'],
    [6 * 86_400 + 86_399, 'in 6 d'],
    [-59, '<1 min ago'],
    [-60, '1 min ago'],
    [-3600, '1 h ago'],
    [-365 * 86_400, '365 d ago'],
  ])('%i s from now is %s', (delta, text) => {
    expect(relativeText(NOW + delta, NOW)).toBe(text);
  });
});
