# Enrollment and roles through the API

- **Status:** implemented (control plane and mocactl).
- **Date:** 2026-11-08
- **Issue:** [#739](https://github.com/rossoctl/moca/issues/739)
- **Builds on:** [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md) §4.2 (enrollment),
  [template lifecycle](2026-11-03-template-lifecycle-and-provenance-design.md) §3.1 (the store
  directory), §5 (authorization out of scope there) and §7 (provenance).

## 1. The problem

Who may use the sandbox service, and who is an admin, are **deployment settings**:

- `SH_ALLOWED_SUBJECTS`, the enrolled subjects (sandbox profile);
- `SH_ADMIN_SUBJECTS`, the admin role (`rolesFor` in `identity.ts`, read when a token is issued or
  refreshed).

Changing either means editing the deployment's settings and re-running `setup.sh`, a cluster write by
an operator. The change reaches a logged-in subject at its next token refresh, and leaves no record on
any provenance chain. Every other template-level activity is becoming an API call with a provenance
record; user management is the one that is not.

Seen in practice: each time a one-off admin action was needed through the API (loading a policy,
handing a declared template over to a subject), the deployment ran three steps. It added a temporary
admin by `setup.sh`, the admin acted through the API, and it removed the admin by `setup.sh` again:
two cluster writes for one API call.

## 2. Goals and non-goals

**Goals:**

- An admin enrolls and unenrolls subjects, and grants and revokes the admin role, through the API.
- Every change is a provenance record (who, whom, what, before), verifiable offline.
- A change takes effect at the subject's next request, not only at its next refresh.
- The deployment still decides who is admin first (the bootstrap), and can always recover.

**Non-goals:**

- An identity provider: the subjects stay those the existing logins mint (`github:<id>`, and
  `oidc:<sub>` with the OIDC provider of #701).
- Fine-grained permissions beyond the admin role: no per-template roles (§6, decision 2).
- Self-enrollment requests (§6, decision 3).
- Groups or tenants. MU2's tenant partition is separate.

## 3. The model

- **A members store** in the control plane's template store directory (`SH_PROVENANCE_DIR`), as
  `members.json`: per subject, `{subject, enrolled, roles, since, by}`.
- **The bootstrap admins** are `SH_ADMIN_SUBJECTS`, as today. They are always admins and cannot be
  revoked through the API (the recovery path). API-granted admins are additional.
- **Enrollment** is `SH_ALLOWED_SUBJECTS` ∪ the store's enrolled subjects (∪ the admins, as today).
  The env list stays the bootstrap and is never edited by the API: a subject on it cannot be
  unenrolled through the API, which answers so.
- **Roles are evaluated per request** from the bootstrap list plus the store, not only at token
  issue. A revoked admin loses the role at its next request. A token's `roles` claim reports what
  held when it was minted.
- **An admin grant may carry an expiry** (`until`, epoch seconds, at most 366 days ahead, so a
  value in milliseconds is refused rather than read as a date that never comes). Past it, the role is no longer
  held. The store keeps the grant, and the first request that sees it lapsed writes a `role` record
  (`expired`), once.
- **Only the settings' admins change access.** Enrolling, unenrolling, granting and revoking need an
  admin named in `SH_ADMIN_SUBJECTS`. An API-granted admin holds the role on every other admin route
  and may read the list, but changes no one's access (`403 forbidden`). Every change is recorded,
  naming who made it.
- **One subject grammar** for every route that names a subject: `MEMBER_SUBJECT_RE` in
  `identity.ts`, `github:<numeric id>` or `oidc:<provider sub>`, built from the same pattern the OIDC
  login verifies. Never `test:<n>`: a test user is enrolled by `SH_TEST_USERS`, which the sandbox
  profile refuses.

## 4. The API (reads: any admin; changes: an admin named in the settings; both route profiles)

| Route                                       | Body               | Effect                                                                                                                                                  | Record                          |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `GET /v1/subjects`                          |                    | every enrolled subject, with roles and `source: env \| api`                                                                                             |                                 |
| `PUT /v1/subjects/{subject}`                | `{enrolled: true}` | enroll (a subject the settings enroll is answered unchanged, `record: null`)                                                                            | `member` (enrolled, before)     |
| `DELETE /v1/subjects/{subject}`             |                    | unenroll (refused for a bootstrap subject: `409 bootstrap_subject`; for a subject holding an admin grant, which keeps it enrolled: `409 admin_granted`) | `member` (unenrolled, before)   |
| `PUT /v1/subjects/{subject}/roles/admin`    | `{until?}`         | grant admin (`until` optional)                                                                                                                          | `role` (granted, until, before) |
| `DELETE /v1/subjects/{subject}/roles/admin` |                    | revoke admin (refused for a bootstrap admin and for oneself)                                                                                            | `role` (revoked, before)        |

- **Errors:** 400 for a malformed subject or body, or no store; 403 for a caller who is not an
  admin, or (a change) not an admin named in the settings; 409 for a bootstrap subject
  (`bootstrap_subject`) or for revoking oneself (`self_revoke`).
- **Records:** on a new stream `members`. Each names the acting subject, and the chain makes the
  whole history verifiable offline with `verify-provenance.py`.
- **mocactl:** `mocactl sbx admin subjects [--json]`, `… enroll|unenroll SUBJECT`,
  `… grant SUBJECT [--until 30m|2h|1d|EPOCH]`, `… revoke SUBJECT`. Each change reads the list first,
  writes, then compares: it prints old → new, and fails loudly if the value changed between its read
  and its write. A login issued for another deployment is refused before any write.

## 5. Effects on what exists

- **Unenrolling a subject:**
  - its live sandboxes run to their expiry (or an admin deletes them);
  - its templates keep their owner;
  - its requests are refused at the next one (`403 not_enrolled`), as after a refresh today.
- **One-off admin actions** need no `setup.sh`: a settings admin grants a temporary admin with
  `until`, which acts and then lapses on its own, with no revoke step.
- **The harness profile:** enrollment does not gate sessions there today (`isEnrolled` is always
  true on `harness`). This design does not change that.

## 6. Decisions

1. **Who may change access:** only an admin named in the settings (`SH_ADMIN_SUBJECTS`) may enroll,
   unenroll, grant or revoke. An API-granted admin cannot widen or narrow access, so access never
   goes beyond what the settings' admins choose. They stay the recovery path: they cannot be revoked
   through the API, and none can revoke itself.
2. **Per-template roles:** none for now. The owner and the admins cover every case seen so far. A
   `maintainer` role (tags, builds, retire; no ownership transfer) can be added later without changing
   this design.
3. **Self-enrollment requests:** none for now. An admin enrolls a subject directly.
4. **Expiry:** an admin grant may carry an optional `until`. The role then lapses by itself, so a
   temporary admin needs no revoke step, and the record names the expiry.

## 7. Tests

- **Unit** (`packages/control-plane/test/members.test.ts`): enrollment and role evaluation per
  request, the bootstrap rules, the 409s, expiry, and the records and their chain; an `oidc:` subject
  enrolled, `test:1` and malformed subjects refused. `provenance.test.ts` runs `verify-provenance.py`
  on a `members` stream and on a member kind outside it.
- **Client** (`packages/mocactl/test/sbx-admin-subjects.test.ts`, `contract.test.ts`).
- **On a deployment:** a settings admin runs `mocactl sbx admin subjects grant github:<id> --until
30m`; that subject's next request acts as admin, with no `setup.sh` run; after 30 minutes it no
  longer does, and the `members` stream holds `granted` then `expired`, verified offline.

## 8. As built

- **The store:** `members.json` in `SH_PROVENANCE_DIR` (`packages/control-plane/src/members.ts`),
  read through an in-memory copy refreshed when the file's inode, size or mtime changes, so the per-request
  evaluation costs one `open` and `fstat` of the file (a parse only when it changed), and none for
  an admin named in the settings. A change appends its record before the file is replaced: a
  crash between the two leaves a record for a change the store does not hold, never the reverse.
- **Per request:** the router (`server.ts`) replaces a verified token's `roles` with the subject's
  roles now and sets `enrolled` from the store, both from one read (`MembersStore.membershipNow`); a
  token never carries `enrolled`. If `members.json` can't be read (damaged by hand, a bad restore, an
  I/O error), the settings' subjects are still answered from the settings (a warning is logged at most once a minute, with the count since the last, and
  an API grant or store enrollment doesn't count until it is fixed); everyone else fails closed. The
  device login, the test-user login, the refresh and the egress owner check use the same evaluation
  (`membershipNow`, `handler-util.ts`). Without a store (no `SH_PROVENANCE_DIR`), the token's claims
  stand, as before.
- **Routes** (`member-handlers.ts`), on both route profiles like the template routes. With no store
  they answer `400 invalid_request`.
- **Records:** on stream `members`. `member` is `{subject, enrolled, before}`; `role` is
  `{subject, role, state: granted | revoked | expired, until, before}`. Their `subject` is the acting
  admin, or `control-plane` for an `expired`, which is written once, by the first request that sees
  the lapse. The two kinds belong to the `members` stream only, and it holds no other kind; both
  verifiers check it.
- **The store's own enrollment** is shown apart (`storeEnrolled` in each `Subject`): `enrolled`
  folds in the settings and an admin role. An enroll of a subject the settings enroll writes
  nothing, so the store never holds an enrollment hidden behind `source: env` that would keep the
  subject enrolled after the settings drop it.
- **Decided here:** a grant to a subject not yet enrolled is allowed: the admin role enrolls it, as a
  bootstrap admin is. Re-granting an unexpired grant with the same `until` writes nothing; with
  another `until` it writes a new `granted` record.

## 9. Limits

- **A record is an attempted change; `members.json` is the state.** A change's record is appended
  before the file is replaced, so a crash or a failed write between the two leaves a `member` or
  `role` record for a change the store does not hold (never the reverse), and the caller's retry
  appends a second one with the same body. Read the stream as a log of intent; `GET /v1/subjects`
  and the file say what is in effect.
- **Unenrolling an admin** is refused (`409 admin_granted`): an admin is enrolled by its role, so
  revoke the role first, then unenroll.
- `mocactl sbx login` against an OIDC deployment is not verified here; the server tests use `oidc:`
  subjects directly.
- On a deployment with a store, a login minted as a user acts as an admin if its subject holds an
  API grant: an access review reads `GET /v1/subjects` and the `members` stream.
