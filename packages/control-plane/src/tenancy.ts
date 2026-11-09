/** The deployment's tenancy mode (MI1 §10.1). Default `single`; anything else is a boot failure. */
export type Tenancy = 'single' | 'multi';

const CORE = 'TENANCY';
// Segments an operator might put in front of the word: this package's knobs are SH_-prefixed, the
// repo was kagenti before it was MOCA, and "multi" is the value an operator is trying to set.
const LEADING = ['MOCA', 'KAGENTI', 'SH', 'MULTI'];
// Kubernetes injects <SERVICE>_SERVICE_HOST, _SERVICE_PORT[_<name>], _PORT and _PORT_<n>_<proto>[_*]
// for every Service in the namespace (enableServiceLinks). A Service named `tenancy` or
// `moca-tenancy` must not crashloop every pod beside it.
const SERVICE_LINK =
  /_(SERVICE_HOST|SERVICE_PORT(_[A-Z0-9_]+)?|PORT|PORT_\d+_(TCP|UDP|SCTP)(_[A-Z]+)?)$/;

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (a.length < b.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Strip known leading words glued onto a segment (`MOCATENANCY`, `MULTITENANCY`) — repeatedly. */
function core(segment: string): string {
  let out = segment;
  for (let changed = true; changed;) {
    changed = false;
    for (const p of LEADING) {
      if (out.startsWith(p) && out.length > p.length) {
        out = out.slice(p.length);
        changed = true;
      }
    }
  }
  return out;
}

const tenancyLike = (c: string): boolean => c.startsWith(CORE) || editDistanceAtMostOne(c, CORE);
// After a leading word, any TENAN... is an attempt at this switch: `MOCA_TENANCIES` (two edits),
// `MOCA_TENANT`, `MOCA_MULTI_TENANT`. Bare, without one, `TENANT` stays another product's word.
const TENAN = 'TENAN';

/**
 * Whether `name` looks like an attempt at MOCA_TENANCY without being it. The name is split into
 * segments on anything that is not a letter or digit, case ignored. It is a near-miss when some
 * segment, after stripping glued-on MOCA/KAGENTI/SH/MULTI, is within one edit of TENANCY or starts
 * with it, AND every segment before that one is itself one of those leading words. So
 * `SH_TENANCY`, `MULTI_TENANCY`, `SH_MOCA_TENANCY`, `MOCA_MULTITENANCY`, `MOCA_TENENCY`,
 * `MOCA__TENANCY` and `MOCA_TENANCY_MODE` are refused. Once a leading word has been seen -- as its
 * own segment or glued on -- any segment starting TENAN is refused too, which catches
 * `MOCA_TENANCIES`, `MOCA_TENANT`, `MOCA_MULTI_TENANT`, `MOCA_MULTITENANT` and `SH_MULTI_TENANT`.
 * Another product's `OCI_CLI_TENANCY`, `MAINTENANCE_MODE` and a bare `TENANT` (two edits, and no
 * leading word) are not. Kubernetes service-link variables are exempt.
 *
 * The `MOCA_TENAN*` names (and `SH_`/`KAGENTI_` alike) are therefore reserved: a leftover such as `MOCA_TENANCY_OLD` is a
 * boot failure too, and the fix is to unset it. A variable that silently fails to set tenancy costs
 * every `multi` protection; one that refuses to boot costs a restart.
 */
export function isTenancyNearMiss(name: string): boolean {
  if (name === 'MOCA_TENANCY') return false;
  const upper = name.toUpperCase();
  if (SERVICE_LINK.test(upper.trim())) return false;
  const segments = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  let led = false;
  for (const segment of segments) {
    const c = core(segment);
    led ||= c !== segment; // a leading word glued onto this segment counts as one seen
    if (tenancyLike(c) || (led && c.startsWith(TENAN))) return true;
    if (!LEADING.includes(segment)) return false;
    led = true;
  }
  return false;
}

export function readTenancy(env: NodeJS.ProcessEnv): Tenancy {
  const misnamed = Object.keys(env).find(isTenancyNearMiss);
  if (misnamed !== undefined) {
    throw new Error(
      `unrecognised variable '${misnamed}': the tenancy switch is MOCA_TENANCY (unset '${misnamed}' to boot)`,
    );
  }
  const raw = env.MOCA_TENANCY;
  if (raw === undefined || raw === 'single') return 'single';
  if (raw === 'multi') return 'multi';
  throw new Error(`MOCA_TENANCY must be 'single' or 'multi', got '${raw}'`);
}
