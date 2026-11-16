import { describe, expect, it } from 'vitest';
import {
  isIdentityProviderNearMiss,
  refuseMisnamedIdentityProvider,
} from '../src/identity-switch.js';

describe('isIdentityProviderNearMiss (#723)', () => {
  it('refuses a misspelled, re-cased, re-prefixed or extended SH_IDENTITY_PROVIDER', () => {
    for (const name of [
      'SH_IDENTITY_PROVDER',
      'SH_IDENTIY_PROVIDER',
      'sh_identity_provider',
      'SH_IDENTITYPROVIDER',
      'SH__IDENTITY_PROVIDER',
      'SH-IDENTITY-PROVIDER',
      'SHIDENTITY_PROVIDER',
      'MOCA_IDENTITY_PROVIDER',
      'KAGENTI_SH_IDENTITY_PROVIDER',
      'SH_IDENTITY_PROVIDERS',
      'SH_IDENTITY_PROVIDER_OLD',
      'SH_IDENTITY_PROVIDOR',
    ]) {
      expect(isIdentityProviderNearMiss(name), name).toBe(true);
    }
  });

  it('accepts the switch itself and names that are not attempts at it', () => {
    for (const name of [
      'SH_IDENTITY_PROVIDER',
      'IDENTITY_PROVIDER',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'SKIP_GIT_IDENTITY_CHECK',
      'SH_OIDC_ISSUER',
      'SH_GITHUB_CLIENT_ID',
      'SH_IDENTITY',
      'SH_PROVIDER',
      'SH',
      '',
    ]) {
      expect(isIdentityProviderNearMiss(name), name).toBe(false);
    }
  });

  it('leaves Kubernetes service-link variables alone', () => {
    for (const name of [
      'SH_IDENTITY_PROVIDER_SERVICE_HOST',
      'SH_IDENTITY_PROVIDER_SERVICE_PORT',
      'SH_IDENTITY_PROVIDER_PORT',
      'SH_IDENTITY_PROVIDER_PORT_8080_TCP',
      'SH_IDENTITY_PROVIDER_SERVICE_PORT_HTTP',
    ]) {
      expect(isIdentityProviderNearMiss(name), name).toBe(false);
    }
  });
});

describe('refuseMisnamedIdentityProvider', () => {
  it('throws naming the variable and the switch, and passes a clean environment', () => {
    expect(() => refuseMisnamedIdentityProvider({ SH_IDENTITY_PROVDER: 'oidc' })).toThrow(
      "unrecognised variable 'SH_IDENTITY_PROVDER': the identity switch is SH_IDENTITY_PROVIDER (unset 'SH_IDENTITY_PROVDER' to boot)",
    );
    expect(() =>
      refuseMisnamedIdentityProvider({ SH_IDENTITY_PROVIDER: 'oidc', PATH: '/bin' }),
    ).not.toThrow();
  });
});
