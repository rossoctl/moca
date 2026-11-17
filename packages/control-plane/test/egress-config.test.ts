import { describe, expect, it } from 'vitest';
import { egressConfigFromEnv, egressTokenEnvName } from '../src/egress-config.js';

const T = (c: string) => c.repeat(64); // notsecret
const templates = [{ id: 'default', worker: 'sbx_default', description: '', tools: [] }];
const on: Record<string, string> = {
  SH_EGRESS_HOSTS: '[{"id":"kvm","workers":["sbx_default"]}]',
  SH_CREDENTIAL_KEK: Buffer.alloc(32, 1).toString('base64'), // notsecret
  SH_EGRESS_TOKEN_KVM: T('a'),
};

describe('egressConfigFromEnv (SBX0.2b)', () => {
  it('is off with neither setting', () =>
    expect(egressConfigFromEnv({}, templates)).toBeUndefined());

  it('parses hosts, tokens and the 60 s default TTL', () =>
    expect(egressConfigFromEnv(on, templates)).toEqual({
      hosts: [{ id: 'kvm', workers: ['sbx_default'], token: T('a') }],
      ttlSeconds: 60,
    }));

  it('honours a TTL in range', () =>
    expect(
      egressConfigFromEnv({ ...on, SH_EGRESS_CREDENTIAL_TTL_SECONDS: '120' }, templates)
        ?.ttlSeconds,
    ).toBe(120));

  it('refuses one setting without the other', () => {
    expect(() => egressConfigFromEnv({ SH_CREDENTIAL_KEK: 'k' }, templates)).toThrow(/go together/);
    expect(() => egressConfigFromEnv({ ...on, SH_CREDENTIAL_KEK: '' }, templates)).toThrow(
      /go together/,
    );
    expect(() => egressConfigFromEnv({ ...on, SH_EGRESS_HOSTS: '' }, templates)).toThrow(
      /go together/,
    );
  });

  it('refuses a KEK that does not decode, naming the variable', () =>
    expect(() => egressConfigFromEnv({ ...on, SH_CREDENTIAL_KEK: 'k' }, templates)).toThrow(
      /SH_CREDENTIAL_KEK/,
    ));

  it.each([
    ['bad JSON', { SH_EGRESS_HOSTS: '[' }, /SH_EGRESS_HOSTS/],
    ['empty list', { SH_EGRESS_HOSTS: '[]' }, /SH_EGRESS_HOSTS/],
    ['bad id', { SH_EGRESS_HOSTS: '[{"id":"KVM","workers":["sbx_default"]}]' }, /id/],
    [
      'duplicate id',
      {
        SH_EGRESS_HOSTS:
          '[{"id":"kvm","workers":["sbx_default"]},{"id":"kvm","workers":["sbx_default"]}]',
      },
      /twice|duplicate/,
    ],
    ['unknown worker', { SH_EGRESS_HOSTS: '[{"id":"kvm","workers":["sbx_x"]}]' }, /worker/],
    [
      'worker on two hosts',
      {
        SH_EGRESS_HOSTS:
          '[{"id":"a","workers":["sbx_default"]},{"id":"b","workers":["sbx_default"]}]',
        SH_EGRESS_TOKEN_A: T('a'),
        SH_EGRESS_TOKEN_B: T('b'),
      },
      /two hosts/,
    ],
    ['missing token', { SH_EGRESS_TOKEN_KVM: '' }, /SH_EGRESS_TOKEN_KVM/],
    ['short token', { SH_EGRESS_TOKEN_KVM: 'abc' }, /SH_EGRESS_TOKEN_KVM/],
    ['TTL 4', { SH_EGRESS_CREDENTIAL_TTL_SECONDS: '4' }, /5.*300/],
    ['TTL 301', { SH_EGRESS_CREDENTIAL_TTL_SECONDS: '301' }, /5.*300/],
    // Number() alone would take each of these: a unit suffix, a fraction, an exponent, hex, a sign.
    ['a TTL with a unit', { SH_EGRESS_CREDENTIAL_TTL_SECONDS: '60s' }, /integer from 5 to 300/],
    ['a fractional TTL', { SH_EGRESS_CREDENTIAL_TTL_SECONDS: '60.5' }, /integer from 5 to 300/],
    ['an exponent TTL', { SH_EGRESS_CREDENTIAL_TTL_SECONDS: '6e1' }, /integer from 5 to 300/],
    ['a hex TTL', { SH_EGRESS_CREDENTIAL_TTL_SECONDS: '0x3c' }, /integer from 5 to 300/],
    ['a signed TTL', { SH_EGRESS_CREDENTIAL_TTL_SECONDS: '+60' }, /integer from 5 to 300/],
    // The rule is lowercase hex, as setup.sh's rand_hex writes and install-host.sh checks.
    ['an uppercase-hex token', { SH_EGRESS_TOKEN_KVM: T('A') }, /64 lowercase hex/],
  ])('refuses %s, never echoing a token', (_n, over, re) => {
    let msg = '';
    try {
      egressConfigFromEnv({ ...on, ...over }, templates);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(re);
    expect(msg).not.toContain(T('a'));
  });

  it('refuses two hosts holding the same token, naming both ids and never the token', () => {
    let msg = '';
    try {
      egressConfigFromEnv(
        {
          ...on,
          SH_EGRESS_HOSTS:
            '[{"id":"a","workers":["sbx_default"]},{"id":"b","workers":["sbx_other"]}]',
          SH_EGRESS_TOKEN_A: T('c'),
          SH_EGRESS_TOKEN_B: T('c'),
        },
        [...templates, { id: 'o', worker: 'sbx_other', description: '', tools: [] }],
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/SH_EGRESS_TOKEN_A and SH_EGRESS_TOKEN_B hold the same token/);
    expect(msg).not.toContain(T('c'));
  });

  // A KEK rotation leaves a ring, newest first (setup.sh never rewrites one): egress must accept it,
  // and a ring with one bad entry is refused naming that entry.
  it('accepts a multi-entry KEK ring and refuses one with a bad entry', () => {
    const k = (b: number) => Buffer.alloc(32, b).toString('base64'); // notsecret
    expect(
      egressConfigFromEnv({ ...on, SH_CREDENTIAL_KEK: `${k(2)},${k(1)}` }, templates)?.hosts,
    ).toHaveLength(1);
    expect(() =>
      egressConfigFromEnv({ ...on, SH_CREDENTIAL_KEK: `${k(2)},c2hvcnQ=` }, templates),
    ).toThrow(/SH_CREDENTIAL_KEK entry 2/);
  });

  it('maps a host id to its token variable', () =>
    expect(egressTokenEnvName('kvm-1')).toBe('SH_EGRESS_TOKEN_KVM_1'));
});
