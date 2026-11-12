import type { SbxPolicyView } from './api.js';

/**
 * `templates create --dry-run`: the checks the control plane's policy makes at create
 * (packages/control-plane/src/template-policy.ts `checkCreate`) that need nothing but the inputs
 * and the policy's profiles. Not the gate record's trust (the policy's trusted list), not the
 * registries, not the quotas: the server decides those, and its answer is still the decision. Rule
 * ids are the policy's, so a local refusal names the rule the server would; `M7.spec_id` and
 * `M7.spec_image` are the spec's own id and image against the create's.
 */

/** The template id rule (M7), as the policy's TEMPLATE_ID_RE. */
export const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** An image pinned by digest, as the policy's IMAGE_RE: a tag or a `<64 hex>` placeholder fails it. */
const IMAGE_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export interface DryRunInput {
  id: string;
  image: string;
  spec: Record<string, unknown>;
  profile?: string;
  /** The gate record file as it would be sent. */
  gateRecord?: string;
}

export interface DryRunResult {
  rule: string;
  passed: boolean;
  message?: string;
}

export interface DryRun {
  profile: string;
  results: DryRunResult[];
  /** The first failed rule. */
  failed?: DryRunResult;
  /** Advice that does not fail the create. */
  notes: string[];
}

const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

export function dryRun(input: DryRunInput, policy: SbxPolicyView['policy']): DryRun {
  const results: DryRunResult[] = [];
  const notes: string[] = [];
  const rule = (id: string, passed: boolean, message: string) =>
    results.push(passed ? { rule: id, passed } : { rule: id, passed, message });
  const s = input.spec;
  const profileName = input.profile ?? policy.defaultProfile;
  const profile = policy.profiles[profileName];
  rule(
    'profile',
    profile !== undefined,
    `no policy profile '${profileName}' (mocactl sbx policy lists them)`,
  );
  rule(
    'M7.id',
    TEMPLATE_ID_RE.test(input.id),
    `id must match ${TEMPLATE_ID_RE} (refused, never truncated)`,
  );
  rule('M1', IMAGE_RE.test(input.image), 'image must be pinned as repository@sha256:<64 hex>');
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
      typeof probe === 'object' &&
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
  rule('M7.spec_id', s.id === undefined || s.id === input.id, "spec.id must be the create's id");
  rule(
    'M7.spec_image',
    s.image === undefined || s.image === input.image,
    "spec.image must be the create's image",
  );
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
  let gate: Record<string, unknown> | null = null;
  if (input.gateRecord !== undefined) {
    try {
      const g = JSON.parse(input.gateRecord) as unknown;
      gate =
        g && typeof g === 'object' && !Array.isArray(g) ? (g as Record<string, unknown>) : null;
    } catch {
      gate = null;
    }
    rule('gate.json', gate !== null, 'gateRecord is not a JSON object');
  }
  const digest = IMAGE_RE.test(input.image) ? input.image.slice(input.image.indexOf('@') + 1) : '';
  if (s.source_record_digest !== undefined) {
    rule(
      'X10',
      s.source_record_digest === digest,
      "spec.source_record_digest is not the image's digest (X10)",
    );
    rule(
      'X10.record',
      gate !== null,
      'the spec names a gate record (source_record_digest): send it with --gate-record (X10)',
    );
  }
  // The profile's own rules, as far as the gate record's content and the spec decide them; whether
  // the policy trusts the record (X1.trusted) is the server's.
  const req = new Set(profile?.requires ?? []);
  const g = gate as {
    gate?: { passed?: unknown };
    image?: { digest?: unknown };
    observed?: { testbed?: { agent_can_commit?: unknown }; guest?: { git_identity?: unknown } };
  } | null;
  const commitsRefused =
    g?.observed?.testbed?.agent_can_commit === 'no' && g?.observed?.guest?.git_identity === 'none';
  if (req.has('X1')) {
    rule(
      'X1',
      g !== null && g.gate?.passed === true,
      `the ${profileName} profile needs a gate record whose gate passed (X1): --gate-record FILE`,
    );
    rule(
      'X1.image',
      g !== null && g.image?.digest === digest,
      'the gate record is for another image',
    );
  }
  if (req.has('X10') && s.source_record_digest === undefined)
    rule('X10', false, `the ${profileName} profile needs spec.source_record_digest (X10)`);
  if (req.has('X11'))
    rule(
      'X11',
      s.egress === false,
      `a ${profileName} template has no network: spec.egress must be false (X11)`,
    );
  if (s.skip_git_identity_check === true && g !== null)
    rule(
      'X12',
      commitsRefused,
      'skip_git_identity_check, but the gate record does not show commits refused (agent_can_commit no, git_identity none) (X12)',
    );
  else if (req.has('X12') && s.skip_git_identity_check === true)
    rule('X12', false, 'skip_git_identity_check needs a gate record showing commits refused (X12)');
  if (req.has('X14'))
    rule(
      'X14',
      s.probe_status === 'vm' || s.probe_status === 'emulation',
      "spec.probe_status must be 'vm' or 'emulation' (X14)",
    );
  if (req.has('X15') && profile?.envelope.exact) {
    const e = profile.envelope.exact;
    rule(
      'X15',
      guest === e.guestMb && s.vcpus === e.vcpus,
      `a ${profileName} template is ${e.guestMb} MiB, ${e.vcpus} vCPUs (X15)`,
    );
  }
  // A profile that requires no gate (base) takes a record without trusting it: said, not refused,
  // since the server admits it too.
  if (profile && !req.has('X1') && input.gateRecord !== undefined)
    notes.push(
      `the ${profileName} profile requires no gate record (X1): it is stored with the build, not trusted`,
    );
  const failed = results.find((r) => !r.passed);
  return { profile: profileName, results, notes, ...(failed ? { failed } : {}) };
}
