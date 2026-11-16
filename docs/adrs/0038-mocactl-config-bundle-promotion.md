# ADR-0038: Promote config bundles through the control plane, not a direct Redis tunnel

- **Status:** Accepted (2026-10-08; implemented by #458), amended 2026-10-06 (see Amendments below) <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-10-06
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-10-06-mocactl-config-bundle-promotion-design.md`](../specs/2026-10-06-mocactl-config-bundle-promotion-design.md)

## Context

ADR-0030 built config-bundle promotion — build a Claude-Code-shaped `.claude/skills` +
`.claude/commands` directory into a content-addressed tar, preflight/secret-scan it, upload to Redis,
reference it as `configRef: sha256:…`. The only shipped uploader is a Claude Code slash command that
shells out to `pnpm --dir <harness> promote`, which writes to the cluster's Redis directly over a
`kubectl port-forward` tunnel the caller holds open, and the only consumer is the batch `/runs` path.
That fits the one developer who already has `kubectl` access to the cluster.

ADR-0037 and the P6-on-Kubernetes slices stand up an always-on, multi-user control plane (ADR-0033)
that ordinary users reach only over its public `/v1` HTTP API — device-flow login, an API token, no
`kubectl` context, no Redis credentials. `mocactl` (ADR-0036) is that API's terminal client, and it
already creates sessions and streams turns against the harness. But a `mocactl` user has no way to
get their own skills into a session: the only promotion path needs cluster access, nothing on a
session records a bundle, and the interactive `/v1/turn` path ignores `configRef` entirely.

Separately, `buildBundle` requires an `entry` (one `.claude/commands/<name>.md` prompt), because
ADR-0030 was designed around batch dispatch where one fixed prompt is "the task." `mocactl` sessions
are interactive chat with no such fixed first prompt.

## Decision

We will add a control-plane-mediated upload for the **same** bundle ADR-0030 already defines — no
format, preflight, secret-scan, or sandbox-materialization change — record the digest on the session,
and apply it on the interactive turn path:

1. **`POST /v1/config-bundles`** (new control-plane route, `auth: api`, its own 12 MiB body limit,
   8 MiB tar cap): accepts a client-built `{ digest, tar }`, re-verifies the digest server-side, and
   stores it via the existing `putBundle` — relocated from `harness/src/config-store.ts` into
   `@moca/config-bundle` so the control plane can call it without depending on the harness.
2. **`configRef` is set once, at session creation** (`POST /v1/sessions`), recorded on
   `SessionRecord` like `credentialName`, and **delivered to the harness by the control plane** in
   the per-turn credential exchange it already performs. The client never sends `configRef` to the
   harness, so it cannot change a session's bundle.
3. **The harness's `/v1/turn` applies it**, using the resolve/overlay/cleanup code lifted out of
   `run-leaf.ts` into one helper both paths share. A missing or expired bundle fails the turn with
   `410 config_bundle_not_found`; it never runs the turn without its skills.
4. **`mocactl` builds the bundle client-side** with `@moca/config-bundle`, behind a shared
   `promoteDirectory` used by `mocactl promote <dir>`, `mocactl run --config <digest>`, and an in-app
   `/promote <dir>` whose result attaches to the next session created. This is a **named exception to
   ADR-0036's no-`@moca/*`-dependency rule**, for exactly that package, enforced as a one-entry
   allow-list in `layering.test.ts`.
5. **`entry` becomes optional** in `buildBundle`; omitting it skips only the entry-specific checks.
6. **No bundle ownership record.** A digest stays a bare content-addressed key; the control plane
   mediates the write so a user never needs cluster credentials, and does not become a new
   authorization boundary over bundle contents.

### Alternatives considered

- **Server-side bundle building** — rejected: unscanned file contents would cross the network before any secret-scan runs, breaking ADR-0030's "nothing sensitive leaves the machine until preflight passes".
- **Owned bundles, like credentials** — deferred: more consistent with MU1/MU2's per-tenant model, but a new store and a per-turn check for a resource that is already an unguessable hash kept secret-free by preflight.
- **Per-turn client-supplied `configRef`** — rejected: a client bug could swap bundles mid-session, and the record on the control plane would not be what actually ran.
- **`configRef` as a session-token claim** — rejected: the exchange already reads the session record every turn, so a claim would duplicate the fact and every re-mint would have to carry it.
- **Vendoring `@moca/config-bundle` into `mocactl`** to keep ADR-0036 absolute — rejected: a stale copy of the secret scanner in the client is exactly the drift that matters.
- **A synthetic/placeholder `entry`** — rejected: dead weight in every lockfile and digest, for a check that means nothing without a batch entry point.

## Consequences

- Positive: a `mocactl` user on a P6-on-Kubernetes deployment can promote and use their own skills
  with zero cluster credentials, while the bundle mechanism itself stays exactly as ADR-0030 proved
  it.
- Positive: a session's bundle is fixed at creation and enforced by the control plane, not by client
  good behaviour — the same shape `credentialName` already established.
- Positive: `/runs` and `/v1/turn` share one overlay implementation instead of two.
- Changed from ADR-0030: the store keeps only the verified content, re-canonicalised, without the
  embedded `lockfile.json` (nothing reads it at run time; the audit copy is the one `promote` writes
  locally), so the stored bytes are a function of the digest and no uploader can pin them.
- Negative / accepted cost: a bundle digest is a bearer capability — any session token that knows a
  digest can reference it. Revisit if cross-tenant bundle reuse becomes a real incident.
- Negative / accepted cost: every turn on a promoted session fetches its bundle and refreshes the
  sandbox overlay. The pod-side unpack is digest-cached and the overlay refcounted, but the cold-turn
  delta is unmeasured.
- Negative / accepted cost: ADR-0036's dependency rule is no longer absolute. The exception is
  justified by what the rule protects (no pi, no server internals, no substrate assumptions — none of
  which `@moca/config-bundle` carries) and kept from spreading by the allow-list test.
- Negative / accepted cost: "read a Claude-Code-shaped directory into `BuildBundleInput`" has two
  implementations (the harness CLI's and `mocactl`'s). A third caller should factor it into
  `@moca/config-bundle`.
- Negative / accepted cost: rollout order matters — the harness must be upgraded before the control
  plane. An older harness ignores `configRef`, so turns would run without the skills and no error.
- Follow-up owed: `GET /v1/config-bundles/{digest}` (metadata only) if bundle reuse across sessions
  turns out to matter.
- Positive: uploads are bounded by a per-subject (`SH_BUNDLE_SUBJECT_BYTES`, 16 MiB) and a
  deployment-wide (`SH_BUNDLE_TOTAL_BYTES`, 64 MiB) budget of stored bytes (4 KiB floor per bundle);
  a new digest over either is refused with `429 bundle_quota_exceeded`, and entries age out with the
  bundle's 30-day TTL. The check is serialized in-process, which assumes a single control-plane replica.
  The subject share is a quarter of the total, so it takes four subjects, not two, to fill it, and
  still holds one incompressible max-size bundle (~10.7 MiB stored).
- Positive: `DELETE /v1/config-bundles/{digest}` (`mocactl bundles delete`) frees budget. The subject
  the digest is charged to, or an `admin`, may delete it; a bundle stored by ADR-0030's `/promote`
  has no budget entry and is admin-only. Sessions on a deleted bundle get 410 on their next turn.
- Negative / accepted cost: the budget is still first-come. Subjects that hold their share and keep
  re-uploading can keep the deployment full until an admin deletes their bundles
  (`SH_ADMIN_SUBJECTS`); a per-subject share small enough to rule that out would refuse a max-size
  bundle.
- Follow-up owed: LRU cleanup of the harness pod's `/tmp/sh-config` digest cache, which today grows
  with every distinct digest a pod resolves.

## Amendments

**2026-10-06, during planning.** Amended in place rather than superseded, because this ADR is still
`Proposed` (`docs/adrs/README.md` Rule 1). Reading the code against the first version found that:

1. **`/v1/turn` never applied `configRef`.** The first version assumed it did, and wired the digest
   only from the client. Decision 3 (harness work) is new.
2. **The first version contradicted itself** — it rejected a per-turn client-supplied `configRef`,
   then had `mocactl` send one on every turn. Decision 2 now has the control plane deliver it through
   the exchange.
3. **The control plane's 64 KiB body cap** would have refused every upload; decision 1 now carries a
   per-route limit and an explicit bundle cap.
4. **ADR-0036 forbade the `@moca/config-bundle` dependency** decision 4 relies on; the exception is
   now stated and test-enforced rather than implicit.

The spec's amendment note carries the code references.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
