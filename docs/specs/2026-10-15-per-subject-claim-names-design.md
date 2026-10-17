# Per-subject claim names — caller-named PVCs scoped by construction — Design

**Date:** 2026-10-15 · **Status:** Proposed (revised 2026-10-15 after review of #543) · **Issue:**
[#358](https://github.com/rossoctl/moca/issues/358) — the second half; the first half
(subject-scoped workload names) shipped with #350/#482.
**Builds on (reuse, no redesign):** [MI1](2026-09-28-moca-multi-user-isolation-design.md)
(§4.3 records the stop-gap, §13 the deferral); the `/workloads` lifecycle
(`packages/knative-server/src/workloads.ts`: `WORKSPACE_FIELDS`, `publicView`);
[context-service](../context-service.md) (Moca's client for Context Service's trusted, storage-only
API, which already names the user in `X-Context-Subject`);
[rossoctl/context-service](https://github.com/rossoctl/context-service) (the service itself — this
design needs a companion change there, §2.2);
[mocactl-control-plane-client-design](2026-09-25-mocactl-control-plane-client-design.md) §7
(`workloads create`/`get`). Everything on the Moca side is additive or lifts a refusal.

## 1. Problem

`POST /workloads` once forwarded a caller-supplied `workspace.claimName` toward Context Service
(`e3abc55`), and nobody checked that the caller may use that PVC: owning a workload says nothing
about owning the volume it names, so a user could run on — and read — another user's workspace.
#350's review closed that hole with a stop-gap: `claimName` is refused outright
(`workspace_field_not_allowed`, since `WORKSPACE_FIELDS = {size, storageClass}`), which removes
bring-your-own-PVC from every multi-user deployment entirely.

Against Context Service as it stands (`rossoctl/context-service` main `7951826`, verified in #543's
review), forwarding any claim name could not work anyway:

- `contextresource.Storage` carries only `backend`, `size`, `accessMode`, `storageClass`, and
  `createContextAs` decodes with `DisallowUnknownFields` — a `storage.claimName` is a
  `400 invalid_request`, which Moca surfaces as `502 context_service_error`.
- `buildContextPVC` always **creates** a PVC named `context-<name>`, and `DeleteContext` deletes
  it. There is no attach-an-existing-claim mode, so even an accepted claim name would mean
  `workloads delete` destroys the caller's pre-created volume.

#358 asks for the stop-gap to be replaced by authorization: a caller may name **their own** claim
and nobody else's. Subject-scoped workload names — the other half of #358 — are already built:
record keys carry an owner hash, and another user's workload is indistinguishable from a missing
one.

### Acceptance

1. An authenticated caller can create a workload over a claim they name (`workspace.claimName`),
   and the revision that workload runs is the one stored on the caller's claim —
   bring-your-own-PVC works under `MOCA_TENANCY=multi`.
2. A caller cannot cause a Context to be attached to a claim outside their own scope, whatever they
   send and whatever Moca forwards: Alice naming `data` never produces Bob's claim name — not by a
   check that could be incomplete, but by construction.
3. The caller learns the exact claim name to pre-create (it is theirs, so revealing it to them is
   safe) and nobody else's.
4. The stop-gap refusal is gone; `workspace_field_not_allowed` still guards every field this design
   does not add.
5. Deleting a workload deletes its Context but never a caller-named claim.

## 2. Design — Context Service derives the claim name and enforces the scope

### 2.1 The shape

The caller names a claim the way they name a workload — a short lowercase slug — and Moca forwards
exactly that, as a new `storage.claimName` field beside `X-Context-Subject` as today. **Context
Service**, not Moca, derives the claim it attaches:

```
moca-<scope>-<claim>     where <scope> = HMAC-SHA256(secret, subjectKey)[:32]
```

- The caller-supplied slug is validated by Moca exactly like a workload name: the existing `NAME`
  regex, at most 50 characters, `400 claim_name_invalid` otherwise. `WORKSPACE_FIELDS` gains
  `claimName`. Context Service validates the same shape again (defense in depth) and refuses a
  create whose storage names a claim it cannot derive from the caller's subject.
- The HMAC input is pinned to `subjectKey` — `kind + ":" + name`, the encoding
  `subjectKey` already uses (`access.go:315`) — so a `user:x` and a `serviceaccount:x` never share
  a scope, and any reimplementation derives the same names. For Moca's callers the subject is
  `user:<owner>`, the same string `X-Context-Subject` carries today.
- The secret is **Context Service's own** — a new setting there (e.g. `CONTEXT_CLAIM_SECRET`),
  stable per deployment. Keying the scope with a secret, rather than a bare hash of the subject,
  makes the derived names unguessable: a caller who knows another subject's string still cannot
  compute that subject's claim names. If the secret is unset, Context Service generates one per
  process, which is fine for a single-replica dev deployment and wrong for more — the same
  trade-off `MOCA_CONTEXT_CACHE_SECRET` makes on Moca's side, stated here so it is a decision
  rather than an accident.
- The derived name is at most 88 characters (`moca-` + 32 hex + `-` + 50), well inside DNS-1123's
  253, and matches its alphabet by construction.

**Why there and not in Moca.** A Context Service change is unavoidable regardless (§1): attaching
an existing claim without adopting or deleting it does not exist there. Given that, deriving the
name where the volume is mounted puts naming, mounting and enforcement in one component under one
secret. Moca-side derivation would need its own secret that is stable across Moca replicas —
`MOCA_CONTEXT_CACHE_SECRET` is explicitly random per process when unset, which is correct for cache
scopings and wrong for names a user must pre-create once — and would leave the scope guessable
anywhere that secret is unset. Moca remains the trusted tier that names the user; this design adds
no new reliance on it, and removes the old one (Moca no longer chooses storage names at all).

### 2.2 The Context Service contract (companion change, in scope)

Recorded here because Moca's half is meaningless without it; tracked as
[rossoctl/context-service#59](https://github.com/rossoctl/context-service/issues/59). **This is
most of the Context Service work, not a
detail:** at `main 7951826` a Context _is_ its managed PVC — the name and type are PVC labels,
the current revision, revision history and frozen revision are PVC annotations (`manager.go`,
`PublishContextRevision`), owner, grants, consumers and audit are annotations too (`access.go`),
`Attachment.ClaimName` is derived from `pvc.Name` at read time (`resourceFromContextPVC`), and the
trusted `contextId` Moca pins on is `StorageUID`, the PVC's UID (`uploads.go:186`; Moca checks it
at freeze, `workloads.ts:359`). None of that can live on a caller-owned claim.

1. **A Context's metadata moves into a record object when the storage is a caller's claim.** A
   namespaced ConfigMap per attached-claim Context — the existing query-index pattern
   (`queryIndexName`) — carries name, type, revision history, frozen revision, owner, grants,
   consumers, audit and the attachment (the derived claim name); revision history and audit keep
   the same bounds they have as PVC annotations, and a custom resource is the recorded escape hatch
   if they outgrow a ConfigMap's 1 MiB ceiling. Writing annotations onto the caller's PVC instead
   is rejected: anyone with edit rights on that PVC could rewrite its grants. Managed-PVC contexts
   keep today's PVC-carried metadata untouched — the change is additive, and a later Context
   Service refactor may unify the two homes. The record is deterministically named for the Context
   name and created with create-if-absent semantics, and the managed path creates the same
   reservation before its PVC — today its uniqueness comes for free from
   `PersistentVolumeClaims.Create` on `context-<name>` (`manager.go:72`) — so a managed and an
   attached create of one Context name cannot both succeed.
2. **`contextId` for an attached-claim Context is its record's UID, never the claim's.** The claim's
   UID is shared by everything that ever attaches it and survives delete-and-recreate, so it
   cannot carry the identity Moca pins on. Upload, freeze and export verify their expected UID
   against the record (today they verify against `pvc.UID`, `context_upload.go`); Moca's pin logic
   is unchanged — it compares the `contextId` Context Service answers with.
3. **One claim backs at most one live Context:** a create naming a claim an attached Context
   already uses answers `409 claim_in_use`. The check is a per-claim marker object,
   deterministically named from the claim and created if-absent — a list-then-create check cannot
   refuse both of two concurrent creates that name the same claim. Deleting that Context removes
   the record and the marker before the claim counts as released, and the re-created Context's
   fresh record has a fresh UID, so the pin stays meaningful.
4. `POST /internal/v1/contexts` (and the public equivalent) accepts
   `storage.claimName: <slug>`. When set, Context Service does **not** create a PVC: it requires an
   existing claim named `moca-<scope>-<slug>` for the request's subject and answers
   `409 claim_not_found` if it is absent — it never provisions one, so a typo cannot silently mint
   a volume. `size` and `storageClass` are ignored on that path.
5. **The claim is a revision store, exactly as a managed PVC is today.** An upload materializes
   into `.context-service/materialized/<digest>/` on it — content-addressed
   (`materializeUploadWithLimit`, `main.go:210`; `UploadContext` refuses any other
   `WorkspacePath`) — the revision id is the digest of exactly what export streams
   (`exportMaterializedRevision`), and export streams only that directory. So the revision a
   workload runs is the one stored on the caller's claim, and the freeze pin's property — the
   revision id is the digest of exactly what export delivers — is unchanged. Pre-existing content
   at the claim's root is invisible: never read, never part of a revision, never exported, never
   overwritten — Context Service touches only `.context-service/` on the claim. Bring-your-own-PVC
   buys the caller the volume's capacity, storage class and placement, not its data. Two footnotes
   on an adopted claim, stated so they are decisions: `ensureMaterializationDirectory` chmods
   `.context-service/` and `materialized/` to 0755, and the expanded-size limit
   (`contextUploadExpandedLimit`) comes from the claim's requested size, not its free space — both
   inherited from the managed path. `DELETE /internal{ctx}` removes the Context — metadata record
   included — but **never the claim** (acceptance 5): the caller's data survives the workload.
6. **The trusted create response gains `attachment.claimName`.** The trusted view omits the PVC
   attachment today, deliberately — "Moca receives content as bundles, not mounts"
   (`uploads.go:106`, mirrored in Moca's `TrustedContext` doc). That rationale is amended rather
   than dropped: for an attached-claim Context the response carries the derived claim name,
   because Moca stores it and returns it to the owner. It is the only attachment field on the
   trusted contract.
7. Context Service never returns or accepts a claim name for one subject's Context to another
   subject — contexts are already subject-scoped there.

### 2.3 Moca's half

- `ContextStorage` (`context-service.ts`) gains `claimName?: string`; `createContext` already
  spreads storage, so the caller's slug flows to Context Service unchanged. `trustedContext`
  learns to read the create response's `attachment.claimName` and Moca validates it — a non-empty
  string matching `^moca-[a-f0-9]{32}-` + the same `NAME` shape — so a misbehaving Context Service
  cannot store garbage on a workload record.
- The **derived** name — not the caller's slug — is stored on the `WorkloadRecord`
  (`workspace.claimName`), so `publicView` returns it in `GET /workloads/{id}`, the `201` from
  create, and `mocactl workloads get`: acceptance 3. It is the owner's own scope, so returning it
  to them is safe, and no other caller's view ever includes it. A workload created before a secret
  rotation keeps its stored name (names are per reservation, stored, never recomputed); only new
  creates derive differently, which is the whole of that migration.
- `size`/`storageClass` validation is unchanged on Moca's side (whether they matter alongside a
  claim is Context Service's contract, §2.2). The anonymous caller of an unauthenticated deployment
  is a subject like any other and gets a stable scope, so bring-your-own-PVC returns there with no
  special case.
- `resolveWorkloadRun` and the sandbox delivery path are untouched: they act on the Context name
  and frozen revision, not on storage.

**mocactl.** `workloads create --claim <slug>` passes `workspace.claimName` through; `get` shows
the derived name in the workspace view (the JSON view already carries `workspace`).

## 3. What is deliberately not built

- **Moca-side derivation** (this spec's first draft, rejected in #543's review). It needs a
  cross-replica-stable secret Moca does not have, leaves names guessable where that secret is
  unset, and splits naming from mounting across repos — while a Context Service change is needed
  anyway.
- **A subject→claims mapping.** An allowlist accepts arbitrary pre-existing PVC names, but needs
  an admin API to manage it, storage, and its own tests — real scope — to buy only a friendlier
  name. Rejected; the derived name is one `mocactl get` away.
- **Reverse listing** (which subject owns a claim) and **claim-name changes** after create. The
  first has no consumer; the second never existed.

### Limits, stated honestly

- The derived name is opaque. Whoever pre-creates the PVC — an operator, or a user with namespace
  access — must obtain it from the owner's `GET /workloads/{id}` (or the create response). That is
  the price of the mapping not existing.
- **Bring-your-own-PVC buys storage, not data.** A claim's pre-existing content is invisible to the
  workload (§2.2 item 5): the caller gets the volume's capacity, storage class and placement, and
  nothing else. Importing the existing tree as a revision — digesting and materializing the claim's
  root content as its own revision, with its own size and type checks (`contextUploadExpandedLimit`,
  the bundle-type check) — is the operation that would change that, and it is deliberately not
  built: it is a further companion change with no consumer yet, recorded here so it is a decision.
- A caller with rights to create PVCs in the Context Service namespace remains
  operator-privileged there (they can mount any claim directly); the keyed scope at least stops
  them computing another subject's name, which a bare subject hash would not.
- `claim_not_found` reaching the caller as a `409` depends on Moca's existing 409 passthrough; any
  other Context Service failure shape stays `502 context_service_error`, as today.

## 4. Testing

- `packages/knative-server/test/workloads.test.ts`: `claimName` validation (`claim_name_invalid`);
  create with a claim → the recorded Context Service call carries the caller's slug in
  `storage.claimName`, and the `201`/`GET` view returns the derived name the (stubbed) Context
  Service answered with; a response whose `attachment.claimName` does not match the required shape
  is refused; `workspace_field_not_allowed` still refuses unlisted fields; the stop-gap case
  (`claimName` → `workspace_field_not_allowed`) is replaced.
- `packages/mocactl/test/workloads.test.ts`: `--claim` passthrough on create; the derived name in
  the `get` view.
- The Alice/Bob proof — the same slug from two subjects derives to two different claim names, and
  a subject cannot attach a claim outside its scope — lives in `rossoctl/context-service`'s own
  suite with the companion change (§2.2), since that is where derivation happens. So do the
  contract's own pins: `claim_not_found` and `claim_in_use`; two concurrent creates naming the same
  claim let exactly one win, and a managed and an attached create of one Context name let exactly
  one win (the shared reservation, §2.2 items 1 and 3); a freeze with a stale `contextId` fails
  against the record's UID; deleting the Context removes the metadata record and leaves the claim;
  Context Service writes only under `.context-service/` on an adopted claim, and pre-existing
  content there never reaches a revision or an export.

## 5. Records

Closes MI1 §13's "per-subject PVC authorization" bullet (the issue's other half, subject-scoped
workload names, was already closed with it). The MI1 §4.3 paragraph keeps its historical account of
the stop-gap; §13's bullet records the closure in place, per that spec's amendment convention. The
Context Service half is tracked as
[rossoctl/context-service#59](https://github.com/rossoctl/context-service/issues/59).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
