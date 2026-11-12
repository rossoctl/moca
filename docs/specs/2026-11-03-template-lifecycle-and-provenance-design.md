# Template lifecycle, readiness and provenance — Design

Version: 0.1 (draft for review) — November 2026
Status: Proposed. This file holds §7, provenance (#730); the other sections (the template store, the
template API, builds and activation on a host, policy) come with the issues that build them, and
keep their numbers so a reference to §7 stays valid.
Builds on: [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md) (templates on the sandbox
profile, the host janitor).

## 7. Provenance

Nothing in the control plane records where a sandbox template came from, who changed it, or which
snapshot a sandbox ran on. The ownership-plane audit stream (`sh:cp:audit`) is trimmed, not chained,
and not exportable as a self-checking document. Provenance is a separate, append-only record: one
hash chain per stream, exportable, and verifiable offline with the Python standard library alone.

### 7.1 Records and the chain

Every step writes one record. A record is JSON, append-only, with `prev` (the digest of the record it
follows) so the chain from the image to a sandbox can be walked and checked. Every record names its
**subject** (who, or `policy` for an automatic decision, `janitor`, or `host:<id>`) and when:

| Record                         | Written when                                                     | Holds                                                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`                       | an admin sets the policy                                         | the profiles, in full; its digest is what every `check` cites                                                                                                                                                                                                    |
| `create`                       | a client creates a template or a build                           | the subject, id, image digest, spec, profile, visibility, the gate record's sha256 if given (the record itself stored beside it)                                                                                                                                 |
| `gate`                         | a gate record is cited                                           | the gate record's sha256 (`record_sha256`), its source (a trusted source, or `client`) and its gate fields                                                                                                                                                       |
| `build`                        | a snapshot is built and its probe passed                         | the template record and the manifest: image digest, manifest hash, kernel, rootfs, agent and snapshot digests, the probe and its result, the Moca commit, the host, when                                                                                         |
| `check`                        | policy is applied, at create and at registration                 | the policy's digest, the profile, each rule and its result, the outcome (`admitted`, `registered`, `rejected`); at registration, `build` is the digest of the `build` record it judged                                                                           |
| `activate` · `deactivate`      | readiness changes                                                | host, worker, manifest hash, subject, reason; each lease stores its `activate` record's digest                                                                                                                                                                   |
| `tag` · `visibility` · `owner` | the owner or an admin changes one                                | the new value and the one before                                                                                                                                                                                                                                 |
| `retire` · `reject`            | a template or build is retired or rejected, or a host removes it | subject, reason, `from` (the status before), `buildRecord`; a host's removal is a `retire` by `host:<id>`                                                                                                                                                        |
| `sandbox`                      | a sandbox is created, and when it ends                           | at create: sandboxId, buildId, templateManifestHash, `lease` (null with no lease), expiresAt; at end: `state: terminated`, `reason` (`deleted` with endedAt, or `expired`, written once by the janitor's sweep when it first sees it; the true end is expiresAt) |
| `session`                      | a Moca Pi session pinned to a template is created and deleted    | as `sandbox`, with sessionId                                                                                                                                                                                                                                     |
| `use` (summary)                | sessions start                                                   | per build and day: count, first and last, by subject                                                                                                                                                                                                             |

A **stream** is `policy` (the deployment's policy records) or `template/<id>` (everything about one
template). A `policy` record belongs to the `policy` stream and nothing else does.

**Every cross-record reference is a record digest** (the sha256 of the referenced record's canonical
JSON), never a time or a name, so a chain composes with no rule but equality: `check.policy` (the
policy record), `check.build`, `retire.buildRecord`, `reject.buildRecord` (the build's `build`
record), `sandbox.lease` and `session.lease` (the `activate` record the lease came from). A run then
joins its build exactly: its build id is the `build` record's manifest hash and the `activate`,
`sandbox` and `session` records' `buildId`; a sandbox's span is its two `sandbox` records, by
sandboxId.

The units that produce each event write its records. The first is the sandbox resource itself: with
a store configured, `POST /v1/sandboxes` writes the `created` record, `DELETE` the `deleted` end, and
the janitor's read the `expired` end. With templates from the fixed `SH_SANDBOX_TEMPLATES` list there
are no builds and no leases yet, so `buildId`, `templateManifestHash` and `lease` are null until the
template store and activation write them. A store written before a kind existed links those events by
time, not by digest; a verifier older than a kind refuses a store holding one.

### 7.2 Hosting, persistence and offline verification

- **Hosted in the control plane**, in a store that is **not Redis**: an append-only directory on the
  control plane's persistent volume (`SH_PROVENANCE_DIR`, opened with the template store, which
  shares the directory; unset, nothing is recorded and nothing changes). One file per record named by
  its digest (`records/`), a head per stream (`heads/`: the latest record's digest and the count), and
  the documents records cite, such as gate records, byte for byte under their sha256 (`blobs/`). A
  record is written (exclusive create, fsync) before its stream's head moves (write-temp, fsync,
  rename), so a crash leaves an orphan record, never a head naming a missing one. Appends to one stream
  are serialized; one control-plane process per directory, as for the file credential store. The
  directory is checked writable at start, so a missing or read-only volume fails the start, not the
  first write. Built: `packages/control-plane/src/provenance.ts` (`ProvenanceStore`).
- **Digests, not signatures**: a record (`moca-provenance-record/1`, with the fields schema, stream,
  seq, prev, kind, subject, at and body) is named by the sha256 of its canonical JSON (keys sorted, no
  whitespace, integers only, printable-ASCII keys, so a second implementation writes the same bytes),
  and names its predecessor's digest in `prev`, with a `seq`, so any edit, drop or reorder breaks the
  chain. Nothing is signed.
- **Exported**: `ProvenanceStore.export()` returns one JSON document (`moca-provenance-export/1`): the
  requested template streams, the policy stream they cite, every exported stream's head and count, and
  the gate records its `gate` records cite. An authorized `GET /v1/provenance/export?template=<id>`
  (the owner, readers of a shared template, admins) is _planned_.
- **Verified offline** by `verify-provenance.py EXPORT.json [--head STREAM=sha256:…]` in
  `deploy/sbx/template-onboarding/` (stdlib Python) or `verifyExport` (the same rules in
  TypeScript; a test runs both on the same exports): every record's digest, each stream's `seq` and
  `prev` chain up to its head and count, record kinds and streams, every blob's sha256, that each `check` cites a policy record and
  each `gate` a blob of the export. An export can only prove itself consistent: `--head` compares a
  head kept elsewhere, which is what catches an export that dropped its latest records. Exit 0
  verified, 1 a check failed (each printed), 2 usage. **Not built yet:** re-running each `check`
  against its policy, and matching a `build` record's manifest hash to a snapshot at hand.
- **Redaction**, for data that must not be kept:
  `deploy/sbx/template-onboarding/redact-provenance.py STORE_DIR TEMPLATE_ID --pattern RE [--apply]`
  (control plane stopped) rewrites the matching records of one stream and every later one, moves the
  head, and appends a note to `redactions.log` (counts and heads, never the matched text);
  `--catalog-only` redacts text only the template catalog keeps. Dry run by default. An export taken
  before a redaction no longer verifies against the new head, by design.
- **The workload plane only reports**: a host posts build results and readiness events. The control
  plane checks and records; it never trusts a report it cannot tie to its chain.
