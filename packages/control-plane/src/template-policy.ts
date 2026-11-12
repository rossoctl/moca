import { createHash } from 'node:crypto';

/**
 * Policy at create (template lifecycle spec §8.1): the checks a template create passes before any
 * build is queued, as machine rules instead of an approver. Each rule carries its id from the
 * gating rules (governance/GATING-RULES.md: M for Moca's own, X for the image builder's extensions),
 * so a refusal names the rule and a `check` record lists every rule with its result.
 *
 * These mirror the build tool's spec checks, which run again on the build host: the control plane
 * refuses early, so a refused create costs no host time, and the host still refuses what slips
 * past (a host is never trusted to have been asked only valid builds).
 */

export const POLICY_SCHEMA = 'moca-template-policy/1';

export interface Profile {
  /** Rule ids beyond the base rules; the benchmark profile's are the X rules. */
  requires: string[];
  /**
   * Self-attestation: a gate record the policy does not trust still passes X1.trusted when the
   * creating subject submitted it, for that subject's own templates only. The build is then
   * self-attested: shown as such, private, never deployment-visible until an admin adds the
   * record's sha256 to trustedGateRecords. Absent: false.
   */
  selfAttest?: boolean;
  /**
   * On a self-attested record only: whether spec.egress may be true (the KVM host's allowlisted
   * egress, never unrestricted). Absent: false. `benchmark-self` keeps it false (benchmark
   * integrity, X11); `general-self` sets it, for general users whose sandboxes need the host's
   * allowlisted network.
   */
  selfAttestEgress?: boolean;
  /**
   * Whether the gate's test floor must have been checked offline (X1.offline,
   * gateFloorCheckedOffline). Absent: true on any profile that requires X1, so `benchmark` and
   * `benchmark-self` refuse a record whose floor needed the network; `general-self` sets it false.
   */
  requireOfflineGate?: boolean;
  /** The size envelope: a spec outside it is refused (X15 for benchmark). */
  envelope: {
    maxGuestMb: number;
    maxVcpus: number;
    maxWorkspaceMb: number;
    exact?: { guestMb: number; vcpus: number };
  };
}

export interface Policy {
  schema: typeof POLICY_SCHEMA;
  /** Profile name -> its rules. `base` must exist. */
  profiles: Record<string, Profile>;
  defaultProfile: string;
  /**
   * Registry hosts an image may come from (the first path component of `repository@sha256:...`).
   * A reference with no host (`images/moca-microvm@...`) is the build host's default
   * registry, allowed as `<default>`.
   */
  allowedRegistries: string[];
  /**
   * Optional, per registry (the key as `registryOf` returns it): the repositories an image may come
   * from there. A registry with no list allows every repository it serves (as before); one with a
   * list allows only those, each an exact repository path (`library/python`) or a prefix ending in
   * `/*` (`library/*`), matched on whole path segments. A registry named here must also be in
   * `allowedRegistries` (Docker Hub, say, opened to named repositories only, not to all of it).
   */
  allowedRepositories?: Record<string, string[]>;
  /**
   * The sha256 of each gate record the benchmark profile trusts (spec §8.3: an admin-loaded
   * copy of the trusted source's records, until a fetch from the trusted source exists).
   */
  trustedGateRecords: string[];
  /** Per-subject quotas (§6.2), the deployment default. */
  quota: Quota;
}

export interface Quota {
  /** Templates a subject owns (not retired). */
  templates: number;
  /** Builds of a subject's queued or building at once. */
  buildsQueued: number;
  /** Templates a subject holds active at once. */
  active: number;
}

export const DEFAULT_POLICY: Policy = {
  schema: POLICY_SCHEMA,
  profiles: {
    base: { requires: [], envelope: { maxGuestMb: 16_384, maxVcpus: 8, maxWorkspaceMb: 16_384 } },
    benchmark: {
      requires: ['X1', 'X10', 'X11', 'X12', 'X14', 'X15'],
      envelope: {
        maxGuestMb: 4096,
        maxVcpus: 2,
        maxWorkspaceMb: 8192,
        exact: { guestMb: 4096, vcpus: 2 },
      },
    },
    // Self-attestation: a subject's own gate record, for its own templates; offline (benchmark integrity).
    'benchmark-self': {
      requires: ['X1', 'X10', 'X11', 'X12', 'X14', 'X15'],
      selfAttest: true,
      selfAttestEgress: false,
      envelope: {
        maxGuestMb: 4096,
        maxVcpus: 2,
        maxWorkspaceMb: 8192,
        exact: { guestMb: 4096, vcpus: 2 },
      },
    },
    // Self-attestation: the same without X11, for general users whose sandboxes need the host's
    // allowlisted egress.
    'general-self': {
      requires: ['X1', 'X10', 'X12', 'X14', 'X15'],
      selfAttest: true,
      selfAttestEgress: true,
      requireOfflineGate: false,
      envelope: {
        maxGuestMb: 4096,
        maxVcpus: 2,
        maxWorkspaceMb: 8192,
        exact: { guestMb: 4096, vcpus: 2 },
      },
    },
  },
  defaultProfile: 'base',
  allowedRegistries: ['<default>'],
  trustedGateRecords: [],
  quota: { templates: 100, buildsQueued: 10, active: 8 },
};

/**
 * The default general-gate record schema (`SH_GATE_RECORD_SCHEMA`): the format an image builder
 * writes for Moca. A deployment that consumes another builder's records sets the setting to that
 * builder's schema string.
 */
export const DEFAULT_GATE_RECORD_SCHEMA = 'moca-gate-record/1';

/**
 * Whether a gate record's test floor was checked offline: a general-gate record (schema
 * `gateRecordSchema`, `SH_GATE_RECORD_SCHEMA`) always carries `gate.floor_checked_offline`, false
 * only from a contract with `network_needed`; fail closed, so absent or false is not offline. Any
 * other schema (the curated family records) predates the field, and their gates ran offline: absent
 * is offline.
 */
export function gateFloorCheckedOffline(
  gate: Record<string, unknown>,
  gateRecordSchema: string = DEFAULT_GATE_RECORD_SCHEMA,
): boolean {
  const v = (gate.gate as Record<string, unknown> | undefined)?.floor_checked_offline;
  return gate.schema === gateRecordSchema ? v === true : v !== false;
}

/** The template id rule (M7); refused past 31 characters, never truncated. */
export const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const IMAGE_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export interface CreateInput {
  id: string;
  image: string;
  spec: Record<string, unknown>;
  profile?: string;
  /** The gate record, as the exact bytes the client sent (its sha256 is what is trusted). */
  gateRecordBytes?: Buffer;
  /**
   * The creating subject (self-attestation): on a `selfAttest` profile, a gate record it submits is
   * trusted for its own template. Who submits is the control plane's to know; nothing in the record
   * counts.
   */
  subject?: string;
  /**
   * The other subjects that already self-attested this gate record's sha256 (keyed by subject and
   * sha256): a self-attested record belongs to its first submitter, so another subject's create on
   * it is refused rather than riding on someone else's attestation.
   */
  gateSelfSubmitters?: string[];
}

export interface RuleResult {
  rule: string;
  passed: boolean;
  message?: string;
}

export interface CheckResult {
  profile: string;
  results: RuleResult[];
  passed: boolean;
  /** The first failed rule, for the 422. */
  failed?: RuleResult;
  gateRecordSha256?: string;
  /**
   * How the gate record is trusted: `trusted`, its sha256 is in trustedGateRecords; `self`, not
   * listed (on a `selfAttest` profile, trusted only by its submitter). Absent with no gate record.
   */
  gateTrust?: 'trusted' | 'self';
  /** The gate record's offline facts (gate.floor_checked_offline, gate.floor_met_offline). */
  gateFloor?: { checkedOffline: boolean; metOffline?: boolean };
}

export function policyDigest(p: Policy): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortKeys(p)))
    .digest('hex')}`;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/**
 * The registry host an image reference names, or `<default>` for one with no host.
 *
 * `<default>` is NOT Docker Hub here: a reference with no host is pulled from the build host's
 * configured registry, so Docker Hub is always written with its host, `docker.io/…`, and
 * `index.docker.io` is read as `docker.io`, so one key covers Docker Hub without ever merging it
 * with the build host's default registry.
 */
export function registryOf(image: string): string {
  const r = registryHostOf(image);
  return r === 'index.docker.io' ? 'docker.io' : r;
}

function registryHostOf(image: string): string {
  const first = image.split('/')[0] ?? '';
  return image.includes('/') &&
    (first.includes('.') || first.includes(':') || first === 'localhost')
    ? first
    : '<default>';
}

/**
 * The repository path of an image reference: without its registry host, its digest and any tag.
 * On Docker Hub (`docker.io`) a one-segment name is an official image, `library/<name>`, as Docker
 * reads it. Other paths compare as given.
 */
export function repositoryOf(image: string): string {
  const name = image.split('@')[0] ?? '';
  const host = registryHostOf(image);
  let path = host === '<default>' ? name : name.slice(host.length + 1);
  // A tag is a final `:x` after the last `/` (a port is in the host, already removed).
  const slash = path.lastIndexOf('/');
  const colon = path.lastIndexOf(':');
  if (colon > slash) path = path.slice(0, colon);
  if (registryOf(image) === 'docker.io' && !path.includes('/')) path = `library/${path}`;
  return path;
}

/**
 * Whether `repo` is admitted by one allowlist entry: an exact path, or a `prefix/*` entry that admits
 * any repository with at least one more path segment under `prefix`. Whole segments only, so
 * `library/python` never admits `library/python-evil` or `library/python/x`.
 */
export function repositoryAllowed(repo: string, entry: string): boolean {
  if (entry.endsWith('/*')) {
    const prefix = entry.slice(0, -2);
    return prefix.length > 0 && repo.startsWith(`${prefix}/`) && repo.length > prefix.length + 1;
  }
  return repo === entry;
}

const REPOSITORY_ENTRY_RE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?:\/\*)?$/;

const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/**
 * Every create-time rule, in order. Returns all results (for the `check` record) and the first
 * failure (for the 422). Never throws on bad input: a malformed field is a failed rule.
 */
export interface CheckOptions {
  /** The general-gate record schema (`SH_GATE_RECORD_SCHEMA`); absent: DEFAULT_GATE_RECORD_SCHEMA. */
  gateRecordSchema?: string;
}

export function checkCreate(
  input: CreateInput,
  policy: Policy,
  opts: CheckOptions = {},
): CheckResult {
  const gateSchema = opts.gateRecordSchema ?? DEFAULT_GATE_RECORD_SCHEMA;
  const results: RuleResult[] = [];
  const rule = (id: string, passed: boolean, message: string) =>
    results.push(passed ? { rule: id, passed } : { rule: id, passed, message });
  const s = input.spec ?? {};
  const profileName = input.profile ?? policy.defaultProfile;
  const profile = policy.profiles[profileName];
  rule(
    'profile',
    profile !== undefined,
    `no policy profile '${profileName}' (GET /v1/policy lists them)`,
  );

  // M7: the id and the spec well formed (the build tool's spec checks).
  rule(
    'M7.id',
    TEMPLATE_ID_RE.test(input.id ?? ''),
    `id must match ${TEMPLATE_ID_RE} (refused, never truncated)`,
  );
  rule(
    'M1',
    IMAGE_RE.test(input.image ?? ''),
    'image must be pinned as repository@sha256:<64 hex>',
  );
  rule(
    'registry',
    IMAGE_RE.test(input.image ?? '') && policy.allowedRegistries.includes(registryOf(input.image)),
    `image registry ${IMAGE_RE.test(input.image ?? '') ? registryOf(input.image) : '?'} is not allowed (policy allowedRegistries)`,
  );
  if (IMAGE_RE.test(input.image ?? '')) {
    const reg = registryOf(input.image);
    const list = policy.allowedRepositories?.[reg];
    if (list) {
      const repo = repositoryOf(input.image);
      rule(
        'registry.repository',
        list.some((e) => repositoryAllowed(repo, e)),
        `image repository ${repo} is not allowed from registry ${reg} (policy allowedRepositories)`,
      );
    }
  }
  const guest = s.guest_mb ?? s.guest_ram_mb;
  rule(
    'M7.guest',
    int(guest) && guest >= 128,
    'spec.guest_mb must be a whole number of MiB, at least 128',
  );
  rule('M7.vcpus', int(s.vcpus) && s.vcpus >= 1 && s.vcpus <= 32, 'spec.vcpus must be 1-32');
  rule(
    'M7.workspace',
    s.workspace_mb === undefined || (int(s.workspace_mb) && s.workspace_mb >= 256),
    'spec.workspace_mb must be a whole number of MiB, at least 256',
  );
  rule(
    'M7.home',
    s.guest_home === undefined ||
      (typeof s.guest_home === 'string' && /^\/tmp(\/[A-Za-z0-9._-]+)+$/.test(s.guest_home)),
    'spec.guest_home must be a path under /tmp',
  );
  rule('M7.egress', typeof s.egress === 'boolean', 'spec.egress must be true or false');
  rule('M7.seed', typeof s.seed === 'string', 'spec.seed must be a string ("" for none)');
  const probe = s.probe as Record<string, unknown> | undefined;
  rule(
    'M7.probe',
    !!probe &&
      typeof probe.cmd === 'string' &&
      probe.cmd.length > 0 &&
      int(probe.expect_rc) &&
      probe.expect_rc >= 0 &&
      probe.expect_rc <= 255 &&
      int(probe.timeout_s) &&
      probe.timeout_s >= 1 &&
      probe.timeout_s <= 86_400 &&
      (probe.expect === undefined ||
        (Array.isArray(probe.expect) &&
          probe.expect.every((e) => typeof e === 'string' && e.length > 0))),
    'spec.probe must be {cmd (non-empty), timeout_s (1-86400), expect_rc (0-255), expect: [regexes]}',
  );
  rule(
    'M7.tools',
    Array.isArray(s.tools) &&
      s.tools.every((t) => typeof t === 'string') &&
      new Set(s.tools).size === s.tools.length,
    'spec.tools must be a list of distinct strings',
  );
  rule(
    'M7.description',
    typeof s.description === 'string' && s.description.length > 0,
    'spec.description must be a non-empty string',
  );
  for (const k of ['skip_git_identity_check', 'guest_home_gitconfig'] as const) {
    rule(
      `M7.${k}`,
      s[k] === undefined || typeof s[k] === 'boolean',
      `spec.${k} must be true or false`,
    );
  }
  // M7.spec_id, M7.spec_image: a spec that names the template's id or image names the create's own.
  // The build takes both from the create (the create's always win), so a different copy in the
  // spec would be silently ignored: refused instead. The same copy is fine: a gate record's
  // template block, sent as the spec unchanged, carries both.
  for (const k of ['id', 'image'] as const) {
    rule(
      `M7.spec_${k}`,
      s[k] === undefined || s[k] === input[k],
      `spec.${k} must be the create's \`${k}\` when present (the build uses the create's)`,
    );
  }
  // M8: a root identity is never copied into an image that refuses commits.
  rule(
    'M8',
    !(
      s.guest_home_gitconfig === true &&
      (s.guest_home === undefined || s.skip_git_identity_check === true)
    ),
    'guest_home_gitconfig needs guest_home, and is refused with skip_git_identity_check',
  );
  rule(
    'M9',
    s.probe_status !== 'unmeasured' && s.probe_status !== 'none',
    `probe_status '${String(s.probe_status)}': its expected result is unmeasured; measure it first`,
  );

  if (profile) {
    const env = profile.envelope;
    rule(
      'envelope',
      int(guest) &&
        guest <= env.maxGuestMb &&
        int(s.vcpus) &&
        s.vcpus <= env.maxVcpus &&
        (s.workspace_mb === undefined ||
          (int(s.workspace_mb) && s.workspace_mb <= env.maxWorkspaceMb)),
      `spec is outside the ${profileName} profile's envelope (guest <= ${env.maxGuestMb} MiB, vcpus <= ${env.maxVcpus}, workspace <= ${env.maxWorkspaceMb} MiB)`,
    );
  }

  // The gate record, when given or required.
  let gate: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  let gateSha: string | undefined;
  if (input.gateRecordBytes) {
    gateSha = `sha256:${createHash('sha256').update(input.gateRecordBytes).digest('hex')}`;
    try {
      const g = JSON.parse(input.gateRecordBytes.toString('utf8'));
      gate = g && typeof g === 'object' && !Array.isArray(g) ? g : null;
    } catch {
      gate = null;
    }
    rule('gate.json', gate !== null, 'gateRecord is not a JSON object');
  }
  const digest = IMAGE_RE.test(input.image ?? '')
    ? input.image.slice(input.image.indexOf('@') + 1)
    : '';
  // X10 applies whenever the spec names a gate record, whatever the profile.
  if (s.source_record_digest !== undefined) {
    rule(
      'X10',
      s.source_record_digest === digest,
      `spec.source_record_digest is not the image's digest (X10)`,
    );
    rule(
      'X10.record',
      gate !== null,
      'the spec names a gate record (source_record_digest): send it as gateRecord (X10)',
    );
  }
  const req = new Set(profile?.requires ?? []);
  // Self-attestation: a record the policy does not trust, accepted only because its submitter is
  // the one creating.
  const selfAttest = profile?.selfAttest === true;
  const trusted = gateSha !== undefined && policy.trustedGateRecords.includes(gateSha);
  const selfAttested = selfAttest && gateSha !== undefined && !trusted;
  if (req.has('X1')) {
    rule(
      'X1',
      gate !== null && gate.gate?.passed === true,
      'the benchmark profile needs a gate record whose gate passed (X1)',
    );
    rule(
      'X1.trusted',
      trusted || (selfAttested && !!input.subject),
      selfAttest
        ? 'a self-attested profile needs the gate record sent with the create, by the subject who owns the template'
        : 'the gate record is not one the policy trusts (spec §8.3: its sha256 must be listed in trustedGateRecords)',
    );
    rule(
      'X1.image',
      gate !== null && gate.image?.digest === digest,
      'the gate record is for another image',
    );
    if (profile?.requireOfflineGate !== false)
      rule(
        'X1.offline',
        gate === null || gateFloorCheckedOffline(gate, gateSchema),
        `the ${profileName} profile needs the gate's floor checked offline (the record's run needed the network)`,
      );
  }
  if (req.has('X10') && s.source_record_digest === undefined) {
    rule('X10', false, 'the benchmark profile needs spec.source_record_digest (X10)');
  }
  if (req.has('X11'))
    rule(
      'X11',
      s.egress === false,
      'a benchmark template has no network: spec.egress must be false (X11)',
    );
  if (selfAttested) {
    const others = (input.gateSelfSubmitters ?? []).filter((x) => x !== input.subject);
    rule(
      'X1.self.scope',
      others.length === 0,
      'this gate record is self-attested by another subject; a self-attested record counts only for its submitter',
    );
    // A self-run gate is reviewed by no one but its submitter: commits refused always (X12 strict),
    // and egress only where the profile allows it (the host's allowlist, never the template's).
    rule(
      'X12.self',
      gate !== null &&
        gate.observed?.testbed?.agent_can_commit === 'no' &&
        gate.observed?.guest?.git_identity === 'none',
      'a self-attested gate record must show commits refused (agent_can_commit no, git_identity none), whatever the spec (X12)',
    );
    rule(
      'X1.self.egress',
      profile?.selfAttestEgress === true || s.egress === false,
      `the ${profileName} profile allows no egress for a self-attested template: spec.egress must be false`,
    );
  }
  if (s.skip_git_identity_check === true && gate !== null) {
    rule(
      'X12',
      gate.observed?.testbed?.agent_can_commit === 'no' &&
        gate.observed?.guest?.git_identity === 'none',
      'skip_git_identity_check, but the gate record does not show commits refused (X5: agent_can_commit no, git_identity none, both measured) (X12)',
    );
  } else if (req.has('X12') && s.skip_git_identity_check === true) {
    rule('X12', false, 'skip_git_identity_check needs a gate record showing commits refused (X12)');
  }
  if (req.has('X14')) {
    rule(
      'X14',
      s.probe_status === 'vm' || s.probe_status === 'emulation',
      "spec.probe_status must be 'vm' or 'emulation' (X14)",
    );
  }
  if (req.has('X15') && profile?.envelope.exact) {
    const e = profile.envelope.exact;
    rule(
      'X15',
      guest === e.guestMb && s.vcpus === e.vcpus,
      `a benchmark template is ${e.guestMb} MiB, ${e.vcpus} vCPUs (X15)`,
    );
  }
  const failed = results.find((r) => !r.passed);
  return {
    profile: profileName,
    results,
    passed: failed === undefined,
    ...(failed ? { failed } : {}),
    ...(gateSha ? { gateRecordSha256: gateSha, gateTrust: trusted ? 'trusted' : 'self' } : {}),
    ...(gate !== null
      ? {
          gateFloor: {
            checkedOffline: gateFloorCheckedOffline(gate, gateSchema),
            ...(typeof gate.gate?.floor_met_offline === 'boolean'
              ? { metOffline: gate.gate.floor_met_offline as boolean }
              : {}),
          },
        }
      : {}),
  };
}

/** Validates a policy document an admin PUTs; returns the problems (empty = valid). */
export function policyProblems(p: unknown): string[] {
  const out: string[] = [];
  const o = p as Partial<Policy>;
  if (!o || typeof o !== 'object') return ['policy must be an object'];
  if (o.schema !== POLICY_SCHEMA) out.push(`schema must be ${POLICY_SCHEMA}`);
  if (!o.profiles || typeof o.profiles !== 'object' || !o.profiles.base)
    out.push('profiles must include base');
  else {
    for (const [n, pr] of Object.entries(o.profiles)) {
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(n))
        out.push(`profile name ${n} must match ^[a-z][a-z0-9-]{0,30}$`);
      const e = pr?.envelope;
      if (!Array.isArray(pr?.requires) || !pr.requires.every((r) => typeof r === 'string'))
        out.push(`${n}.requires must be a list of rule ids`);
      if (!e || ![e.maxGuestMb, e.maxVcpus, e.maxWorkspaceMb].every((x) => int(x) && x > 0))
        out.push(`${n}.envelope must hold positive maxGuestMb, maxVcpus, maxWorkspaceMb`);
      for (const f of ['selfAttest', 'selfAttestEgress', 'requireOfflineGate'] as const)
        if (pr?.[f] !== undefined && typeof pr[f] !== 'boolean')
          out.push(`${n}.${f} must be true or false`);
      if (pr?.selfAttestEgress === true && pr.selfAttest !== true)
        out.push(`${n}.selfAttestEgress needs selfAttest`);
      if (pr?.selfAttest === true && !pr.requires?.includes?.('X1'))
        out.push(`${n}.selfAttest needs X1 in requires (a gate record to attest)`);
    }
  }
  if (typeof o.defaultProfile !== 'string' || !o.profiles?.[o.defaultProfile])
    out.push('defaultProfile must name a profile');
  if (
    !Array.isArray(o.allowedRegistries) ||
    !o.allowedRegistries.every((r) => typeof r === 'string' && r.length > 0)
  )
    out.push('allowedRegistries must be a list of hosts');
  const repos = (o as { allowedRepositories?: unknown }).allowedRepositories;
  if (repos !== undefined) {
    if (!repos || typeof repos !== 'object' || Array.isArray(repos))
      out.push('allowedRepositories must map a registry to a list of repositories');
    else
      for (const [reg, list] of Object.entries(repos as Record<string, unknown>)) {
        if (!Array.isArray(o.allowedRegistries) || !o.allowedRegistries.includes(reg))
          out.push(`allowedRepositories.${reg}: the registry must also be in allowedRegistries`);
        if (
          !Array.isArray(list) ||
          list.length === 0 ||
          !list.every((e) => typeof e === 'string' && REPOSITORY_ENTRY_RE.test(e))
        )
          out.push(
            `allowedRepositories.${reg} must be a non-empty list of repository paths (a/b, or a/* for a prefix)`,
          );
      }
  }
  if (
    !Array.isArray(o.trustedGateRecords) ||
    !o.trustedGateRecords.every((r) => typeof r === 'string' && /^sha256:[0-9a-f]{64}$/.test(r))
  )
    out.push('trustedGateRecords must be sha256 digests');
  const q = o.quota;
  if (!q || ![q.templates, q.buildsQueued, q.active].every((n) => int(n) && n >= 0))
    out.push('quota must hold whole numbers templates, buildsQueued, active');
  return out;
}

/**
 * The deployment's policy, kept beside the catalog (<SH_PROVENANCE_DIR>/policy.json) and recorded:
 * every change is a `policy` record in the provenance store, whose digest every `check` cites.
 * Until an admin sets one, DEFAULT_POLICY applies, and the first read records it, so a `check`
 * always cites a policy record that exists.
 */
export interface PolicyStore {
  current(): Promise<{ policy: Policy; record: string }>;
  /**
   * Store a new policy, and record it. `extra` is added to the `policy` record's body beside the
   * policy (self-attestation: the builds a trust removal narrows), never into the policy itself.
   */
  set(
    policy: Policy,
    subject: string,
    extra?: Record<string, unknown>,
  ): Promise<{ policy: Policy; record: string }>;
}
