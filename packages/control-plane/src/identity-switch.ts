/**
 * The identity switch's name guard (#723). `SH_IDENTITY_PROVIDER` refuses a wrong value at boot
 * (identityProviderFromEnv), but a misspelled NAME would leave it unset, and the control plane
 * would quietly serve the default github provider. So a near-miss name refuses to boot, as one of
 * MOCA_TENANCY does (tenancy.ts), with the same edit-distance and service-link rules.
 */
import { editDistanceAtMostOne, isServiceLink } from './tenancy.js';

const NAME = 'SH_IDENTITY_PROVIDER';
const CORE = 'IDENTITYPROVIDER';
// The words an operator might put in front: this package's knobs are SH_-prefixed, and the repo
// was kagenti before it was MOCA.
const LEADING = ['SH', 'MOCA', 'KAGENTI'];

/**
 * Whether `name` looks like an attempt at SH_IDENTITY_PROVIDER without being it. The name is split
 * into segments on anything that is not a letter or digit, case ignored. Leading SH/MOCA/KAGENTI
 * segments are dropped, the rest is joined, and a leading word glued onto it is stripped
 * (`SHIDENTITY_PROVIDER`). It is a near-miss when at least one leading word was seen and the rest
 * is within one edit of IDENTITYPROVIDER or starts with it. So `SH_IDENTITY_PROVDER`,
 * `SH_IDENTITYPROVIDER`, `sh_identity_provider`, `MOCA_IDENTITY_PROVIDER`, `SH_IDENTITY_PROVIDERS`
 * and `SH_IDENTITY_PROVIDER_OLD` are refused; a bare `IDENTITY_PROVIDER` (no leading word) and
 * another product's `AWS_WEB_IDENTITY_TOKEN_FILE` are not. Kubernetes service-link variables are
 * exempt.
 */
export function isIdentityProviderNearMiss(name: string): boolean {
  if (name === NAME) return false;
  const upper = name.toUpperCase();
  if (isServiceLink(upper.trim())) return false;
  const segments = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  let led = false;
  while (segments.length > 1 && LEADING.includes(segments[0]!)) {
    segments.shift();
    led = true;
  }
  let rest = segments.join('');
  for (let changed = true; changed;) {
    changed = false;
    for (const p of LEADING) {
      if (rest.startsWith(p) && rest.length > p.length) {
        rest = rest.slice(p.length);
        led = changed = true;
      }
    }
  }
  return led && (rest.startsWith(CORE) || editDistanceAtMostOne(rest, CORE));
}

/** Throws naming the switch when the environment holds a near-miss of SH_IDENTITY_PROVIDER. */
export function refuseMisnamedIdentityProvider(env: NodeJS.ProcessEnv): void {
  const misnamed = Object.keys(env).find(isIdentityProviderNearMiss);
  if (misnamed !== undefined) {
    throw new Error(
      `unrecognised variable '${misnamed}': the identity switch is ${NAME} (unset '${misnamed}' to boot)`,
    );
  }
}
