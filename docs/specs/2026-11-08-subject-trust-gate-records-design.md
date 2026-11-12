# Subject trust for gate records: general-user self-serve for gated profiles

- **Status:** implemented ([#738](https://github.com/rossoctl/moca/issues/738)). A deployment whose
  stored policy predates it gains the two profiles only when an admin adds them (`PUT /v1/policy`);
  the default policy holds them.
- **Date:** 2026-11-08
- **Decisions:** §7, reviewed by a benchmark client and an image builder.
- **Builds on:** [template lifecycle](2026-11-03-template-lifecycle-and-provenance-design.md) §8 (the
  policy and its rules); an image builder's general gate, whose records carry the schema
  `SH_GATE_RECORD_SCHEMA` names (default `moca-gate-record/1`, the format an image builder writes for
  Moca).

## 1. The problem

A gated profile (`benchmark`) requires X1 (a gate record that passed and names the image's digest) and
X1.trusted (its sha256 listed in the policy's `trustedGateRecords`, which only an admin edits). A
general user can produce a gate record with an image builder's general gate, but can't make the
deployment trust it. So gated self-serve was open only to the curated image pipeline.

The route taken:

1. **(b)** an image builder's general gate tool first: any OCI image, from a small contract, to a gate
   record in the format Moca reads.
2. **(c)** this design: per-subject trust in the control plane.
3. **(a)** gate as a service: deferred.

## 2. The idea

**Trust is decided by who submits a gate record, never by anything inside it.** The record is
unsigned bytes, and its sha256 is its identity; a claim of origin inside it proves nothing
(the image builder agrees).

- A subject's own gate record counts **for that subject's own templates only**.
- A template built that way is **self-attested**: visibly so in GET, and on the provenance chain.
- **Deployment-wide trust** stays an admin's act: adding the sha256 to `trustedGateRecords`.

## 3. Two self-attested profiles

The default policy keeps `benchmark` as curated, and adds two profiles with `selfAttest: true`:

| Profile          | Rules                           | Egress                                              | For                                          |
| ---------------- | ------------------------------- | --------------------------------------------------- | -------------------------------------------- |
| `benchmark-self` | X1, X10, X11, X12, X14, X15     | none (`selfAttestEgress: false`, and X11)           | benchmark tasks                              |
| `general-self`   | X1, X10, X12, X14, X15 (no X11) | the KVM host's allowlist (`selfAttestEgress: true`) | general users whose sandboxes need a network |

- **`benchmark-self` is offline for benchmark integrity, not for general safety.** It keeps X11's
  reason: an agent must not be able to fetch the upstream fix.
- **`general-self`** is for general users whose sandboxes need the network. The egress it allows is the
  KVM host's allowlisted egress: the allowlist is the host operator's (`MOCA_EGRESS_ALLOW`, the
  [RUNBOOK's guest egress section](../../deploy/sbx/RUNBOOK.md#guest-egress)), never the template's. No template gets unrestricted network.
- Both have the benchmark envelope (4096 MiB, 2 vCPUs).

## 4. The rules on a self-attested record

On a `selfAttest` profile, when the record's sha256 is not in `trustedGateRecords`:

- **X1.trusted** passes for the creating subject.
- **X1.self.scope:** refused if another subject has already self-attested this sha256. The trust key
  is (subject, sha256), found from the catalog: each build's create names its record's sha256, and the
  template its owner.
- **X12.self:** commits are always refused (`observed.testbed.agent_can_commit == "no"` and
  `observed.guest.git_identity == "none"`), whether or not the spec skips the identity check.
- **X1.self.egress:** `spec.egress` must be false unless the profile sets `selfAttestEgress`.
- X1 (the gate passed), X1.image (the record names this image), X10, X14 and X15 apply unchanged.

A record in `trustedGateRecords` is trusted on any profile, as before.

**X1.offline:** a general-gate record (of the schema `SH_GATE_RECORD_SCHEMA` names, default
`moca-gate-record/1`) always carries `gate.floor_checked_offline`: true, unless its contract
set `network_needed`. `benchmark` and `benchmark-self` require it to be true, and refuse a general-gate
record without it (fail closed): a benchmark's floor must be checked offline. A curated family record
(the moca-microvm records the policy already trusts) predates the field, and its gate ran offline, so
it passes without it. `general-self` (`requireOfflineGate: false`) accepts either value. Its build
shows `gateFloorCheckedOffline`, and, from a `network_needed` gate, `gateFloorMetOffline`
(`gate.floor_met_offline`: whether the offline run met the floor anyway).

## 5. What is recorded and shown

- **The `gate` provenance record** (written at create, its `subject` the submitter): `record_sha256`,
  `source` (`trusted`, `self`, or `client` on a profile that doesn't require X1), `scope` (the
  submitter, for `self`), and `policy` (the policy record in force at create). The submitted bytes are
  a blob, so an admin promoting a record sees exactly what was trusted and by whom.
- **The build** keeps `selfAttested: true` as a fact of its create.
- **`attestation`** (`deployment | self`) on each build and on its template is **recomputed on every
  read** from the current policy: an admin's promotion or removal of the record rewrites nothing.

## 6. Visibility

- A self-attested template is **private**. A create asking for `deployment` visibility and a
  self-attested build added to a deployment-visible template are each refused `409 self_attested`,
  until an admin trusts the record. A visibility edit to `deployment` (`PATCH /v1/templates/{id}`) is
  refused the same way once the template edit route is in; until then a stored visibility changes
  only at create.
- A template's **visibility in effect** is `private` while any of its registered builds is
  self-attested now, whatever is stored, so every list, read and use follows the current policy.
- **Decision (i):** when an admin removes a record's sha256 from `trustedGateRecords`, a
  deployment-visible template whose registered builds become self-attested falls back to **private on
  read**. Other subjects no longer see it in the list, can't read it, and can't use it (a sandbox or a
  session create answers as for an unknown template). Its owner keeps using it.
- So that nothing is silent, `PUT /v1/policy` names the narrowed builds (`narrowed: [{template,
buildId}]`) in its answer and in its `policy` record.

## 7. Decisions

1. **A new profile, not a flag on `benchmark`:** `benchmark` means curated wherever it's cited.
2. **No sharing without promotion:** a self-attested template reaches no one else on its owner's own
   gate.
3. **Rules tightened, none loosened:** the same envelope, commits always refused. Egress is a profile
   setting: none on `benchmark-self`, the host's allowlist on `general-self`.
4. **(i):** a trust removal narrows a visible template to private on read, and the removal's record
   names the builds it narrows.

## 8. As built

- `packages/control-plane/src/template-policy.ts`:
  - the profile fields `selfAttest`, `selfAttestEgress` and `requireOfflineGate`, validated by
    `policyProblems`;
  - the two default profiles;
  - in `checkCreate`, the rules of §4 (`X1.self.scope`, `X12.self`, `X1.self.egress`, `X1.offline`),
    `gateTrust` and `gateFloor`.
- `packages/control-plane/src/sandbox-handlers.ts`:
  - `attestationOf` and `effectiveVisibility`;
  - `canSee` on the effective visibility, so every list, read and use (`resolveForUse`) follows it;
  - the create's (subject, sha256) lookup, its gate record body, and its visibility refusals;
  - `putPolicy`'s `narrowed`.
- `PolicyStore.set` takes an `extra` body for the `policy` record, which is never put into the policy.
- `SH_GATE_RECORD_SCHEMA` (`sandbox-config.ts`): the general-gate schema X1.offline reads, default
  `moca-gate-record/1`; `GET /v1/policy` answers it as `gateRecordSchema` for a client's dry run.
- **Tests:** `packages/control-plane/test/subject-trust.test.ts`, including the general-gate record
  shape (no base image, no recipe), the schema setting's default and an override, and a policy write
  keeping every other field.

## 9. Compatibility and limits

- **An older control plane reading a policy that holds these profiles:** `policyProblems` checks only
  each profile's `requires` and `envelope`, so the extra fields are accepted. They are ignored: such a
  control plane treats `benchmark-self` and `general-self` as non-self-attesting profiles, so an
  untrusted record on them is refused at X1.trusted.
- **An older control plane serving a template stored by this one:** it ignores `selfAttested`, and
  shows the stored `visibility`.
- **Old `gate` records** with `source: client` are read unchanged. `verify-provenance.py` checks a gate
  record's cited blob only, so the new fields need no change there.
- **What a self-attested record attests is its submitter's word.** X1.offline checks only what can be
  checked without the image, and nothing re-runs the gate. A gate run by Moca itself (option (a)) is
  out of scope.
