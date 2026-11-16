import { describe, expect, it } from 'vitest';
import { lifetimeText, parseLifetime } from '../src/sbx/lifetime.js';

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
