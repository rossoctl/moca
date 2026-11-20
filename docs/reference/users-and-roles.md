# Users, enrollment and roles

> **Preview.** Enrollment and the admin role are implemented but not yet declared Stable; interfaces
> and limits may change. Known limits: [Design limits](#design-limits).

Who a user is to the control plane, who may log in and use what, who can change that, and what is
left behind when a user goes. The procedures live elsewhere: adding and removing a user on the
sandbox service is [runbook §4](../operate/sandbox-service/runbook.md#4-adding-or-removing-a-user),
the first deployment is [Install the sandbox service](../operate/sandbox-service/install.md), and a
user's own login is [Install, log in and bring a repository up](../sandbox/how-to/set-up.md). Every
route named here is specified in [`docs/api/openapi.yaml`](../api/openapi.yaml), summarized in the
[HTTP API guide](../harness/reference/http-api.md#control-plane).

## Subjects

A **subject** is the stable id the control plane gives one login identity. Users never type it;
the control plane mints it at login (`packages/control-plane/src/identity.ts`):

| Form                  | Minted by                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `github:<numeric id>` | The GitHub device flow: the account's numeric id, never its login name, which can change and be reused |
| `oidc:<provider sub>` | An [OIDC provider](../operate/oidc-login.md): the provider's stable `sub` claim                        |
| `test:<n>`            | `SH_TEST_USERS`, for tests only: `test:1` to `test:<n>`, at most 1000                                  |

An OIDC `sub` is 1 to 128 characters: a letter or digit, then letters, digits and `.`, `_`, `@`,
`+`, `-`. No whitespace, no control characters and no colon (the separator). A subject is one
tenant: sessions, credentials, sandboxes and templates are owned by it.

| Subject                                              | A valid subject | Accepted by `/v1/subjects` and owner transfers                |
| ---------------------------------------------------- | --------------- | ------------------------------------------------------------- |
| `github:12345678`                                    | yes             | yes                                                           |
| `oidc:alex@example.com` (an email-shaped sub)        | yes             | yes                                                           |
| `oidc:0b4e6c1a-7f2d-4c55-9e1b-2a3d4c5e6f70` (a UUID) | yes             | yes                                                           |
| `test:3`                                             | yes             | no: a test user is enabled by `SH_TEST_USERS`, not by the API |
| `github:octocat` (a login name)                      | no              | no                                                            |
| `oidc:a:b` (a colon in the sub)                      | no              | no                                                            |

To find a GitHub user's subject, `gh api users/<login> --jq .id` gives the numeric id. A user the
sandbox service refuses is shown their own subject by `mocactl sbx login`, and `GET /v1/me`
returns the caller's subject and roles.

## Enrollment and the admin role

There is one role, `admin`. Every request asks two questions about its subject `s`:

```
admin(s)    = s in SH_ADMIN_SUBJECTS  or  s holds an API grant of admin whose until (if any) is in the future
enrolled(s) = s in SH_ALLOWED_SUBJECTS  or  the members store enrolls s  or  admin(s)
```

(`members.ts` `membershipNow`, `sandbox-config.ts` `onAllowList`.) The members store and the API
grants exist only on a control plane with a template store (`SH_PROVENANCE_DIR`, on the sandbox
service `SBX_TEMPLATE_STORE=1`); it keeps `members.json` in that directory.

- **With a members store**, both answers are computed on every request, from the settings and one
  read of the store. The router replaces the `roles` claim of a verified token with the answer, so
  a grant, a revoke or a lapsed `until` takes effect at the subject's next request, on every
  profile (`server.ts`). A token's `roles` only report what held when it was minted.
- **Without a store**, the token's `roles` stand until it expires. They come from
  `SH_ADMIN_SUBJECTS`, which the control plane reads at boot, at login and at each refresh.
- **The settings are the bootstrap.** The API never edits `SH_ALLOWED_SUBJECTS` or
  `SH_ADMIN_SUBJECTS`. A subject they name can't be unenrolled or have its role revoked through the
  API (`409 bootstrap_subject`), so the settings are always the way back in
  (`member-handlers.ts`).
- **The admin role enrolls.** An admin by either route is enrolled, and a subject holding a live
  grant can't be unenrolled (`409 admin_granted`): revoke the role first.

### Who can change what

From most to least trusted:

| Actor             | Comes from                                      | May                                                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator          | Access to the deployment's settings             | Edit the settings and re-deploy (`setup.sh`, a restart): the bootstrap lists, every setting below                                                                                                                                                               |
| Settings admin    | `SH_ADMIN_SUBJECTS`                             | Everything an admin may, plus enroll, unenroll, grant and revoke through `/v1/subjects`, and widen the template policy                                                                                                                                          |
| Installer token   | `SH_INSTALLER_TOKEN` (sandbox, combined)        | The `/v1/subjects*` routes only, as a settings admin: list, enroll, unenroll, grant, revoke. Nothing else                                                                                                                                                       |
| API-granted admin | A grant on `/v1/subjects/{subject}/roles/admin` | Every admin route except changing enrollment or roles (`403 forbidden`) and widening the template policy (`403`): read the subject list, templates, quotas, owner transfers, narrowing the policy, another user's sessions (`?owner=`) and sandboxes (`?all=1`) |
| Enrolled subject  | Any of the `enrolled(s)` terms                  | On `sandbox` and `combined`: sandboxes and template writes                                                                                                                                                                                                      |
| Logged-in subject | A login                                         | On `harness` and `combined`: sessions, credentials, bundles, and reads of templates, policy and quota                                                                                                                                                           |
| Anonymous         | Nothing                                         | `GET /v1/discovery` and the login routes                                                                                                                                                                                                                        |

No admin, of either kind, can mint a token for another user's sandbox (run code in it) or change
its mode: those routes are owner-only (`sandbox-handlers.ts` `assertSandboxOwner`).

**The installer token.** `SH_INSTALLER_TOKEN` is a static bearer for automation, an enrollment
sync for example, that needs no login and no refresh tokens. It is read on the `sandbox` and
`combined` profiles, must be at least 32 characters (or the control plane refuses to boot), and is compared in
constant time. A request bearing it on a `/v1/subjects*` route acts as the synthetic subject
`installer` with the admin role, which no login can mint; the store counts it among the settings
admins, so it can change enrollment and roles and appears in `GET /v1/subjects` as an admin from
the settings (`server.ts`, `main.ts`, `identity.ts` `INSTALLER_SUBJECT`). On every other route it
is not a token. On the sandbox service, `deploy/sbx/setup.sh` generates it once into the
`moca-mu1` Secret; rotate it by deleting the key and re-running `setup.sh`. Treat it as you treat
a settings admin's login.

### A damaged `members.json`

If `members.json` can't be read (corrupt, the wrong shape, a bad restore), the control plane fails
closed for everyone the settings don't name (`members.ts` `membershipNow`):

- a subject in `SH_ADMIN_SUBJECTS` is answered from the settings without reading the file;
- a subject in `SH_ALLOWED_SUBJECTS` is answered from the settings alone (enrolled, no API role),
  with a warning in the log at most once a minute;
- every other subject's request fails, so API enrollments and grants count again only once the
  file is restored.

## Who can log in on each route profile

`SH_ROUTE_PROFILE` decides which routes the control plane serves
([Configuration](configuration.md#control-plane)):

| Profile             | Who gets a login                                                                        | Where enrollment is checked                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness` (default) | Any GitHub account (or OIDC identity) that reaches it; test users if configured         | Nowhere: sessions are not gated by enrollment                                                                                                      |
| `sandbox`           | Enrolled subjects only, checked at login (before a login is issued) and at each refresh | Login, refresh, and the sandbox and template routes                                                                                                |
| `combined`          | Anyone, as on `harness`; test users if configured                                       | The sandbox routes, the template writes and a session's first use of a template build; store enrollment and API grants count there as on `sandbox` |

(`sandbox-config.ts` `isEnrolled`, `isEnrolledForSandbox`; `handler-util.ts`
`requireEnrolledPrincipal`.) The `/v1/subjects*` routes are mounted on all three profiles and
answer `400` without a members store. On `harness`, enrolling a subject changes nothing it can do;
only the admin role matters there, and `mocactl sbx admin subjects` does not drive a harness
control plane, so call the API directly. A refusal is `403 not_enrolled`, and its message names the
caller's own subject for the operator to enroll.

## When a user leaves

Remove the subject from the settings, or unenroll it through the API; the commands are in
[runbook §4](../operate/sandbox-service/runbook.md#4-adding-or-removing-a-user). What happens to
the user's things afterwards:

| Thing                                 | After the user is unenrolled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requests with a still-valid API token | On `sandbox`, the sandbox and template routes answer `403 not_enrolled` at the next request. On `combined` only the sandbox routes, the template writes and a session's first use of a build refuse                                                                                                                                                                                                                                                                                                                                                                   |
| The login (refresh token)             | On `sandbox`, the next refresh answers `403 not_enrolled` and revokes the login's whole refresh family (audited as revoked, reason `not_enrolled`). On `combined` and `harness` login stays open, so refresh still succeeds                                                                                                                                                                                                                                                                                                                                           |
| Live sandboxes                        | Not deleted. Each runs to its deadline, which only its owner's activity (a token or mode-token mint, a mode change) moves, and the owner is now refused. With idle lifetimes on (`SH_SANDBOX_MAX_LIFETIME_SECONDS` set) it ends its idle lifetime (`SH_SANDBOX_LIFETIME_SECONDS`, 7 days by default) after its last activity; without them, at the expiry fixed at create. An admin deletes them early with `mocactl sbx ls --all` and `mocactl sbx rm --force <sandbox id>` (`--force`, because an admin is never minted a sandbox token for another user's sandbox) |
| A sandbox token already issued        | Keeps working until it expires: within one token lifetime plus 30 s (15.5 minutes by default). A command still running then is cancelled                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A sandbox in a lease mode             | The lease ends as any lease does ([When a lease ends](../sandbox/how-to/lease-mode.md#when-a-lease-ends)). The mode routes are owner-only, so an admin can't change it: delete the sandbox instead                                                                                                                                                                                                                                                                                                                                                                    |
| Templates                             | Keep their owner. An admin transfers them with `mocactl sbx templates transfer ID SUBJECT` (`PUT /v1/templates/{id}/owner`); the new owner must be enrolled now, by the settings or the store                                                                                                                                                                                                                                                                                                                                                                         |
| Sessions (`harness`, `combined`)      | Not gated by enrollment: a logged-in subject keeps using its sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A session's turn grants               | Not gated by enrollment either. A refresh re-reads the session and stops once it is deleted; a grant already issued lives out `MOCA_GRANT_TTL_S` (300 s), since there is no revocation list                                                                                                                                                                                                                                                                                                                                                                           |

On `harness` there is no way to remove a user from the control plane itself: see
[Manage multi-user sessions §6](../operate/harness/multi-user.md#6-revoke-access). On any profile,
`mocactl logout --all` (`POST /v1/auth/revoke-all`) ends all of the caller's own logins, and no
route ends another subject's logins.

## Credentials and their lifetimes

The API, session and refresh tokens are described in the
[Security model](security-model.md#tokens); their lifetimes are the defaults of the
[configuration](configuration.md#control-plane) settings named below.

| Credential                          | Lifetime (default)                                                                                   | Renewed by                                                                                                | Ends                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Device code, OIDC login state       | The provider's expiry for GitHub (900 s if it gives none); 900 s for OIDC                            | A new `POST /v1/auth/device`                                                                              | At expiry, or when collected                                                                                       |
| API token (`scope: api`)            | 900 s (`SH_API_TOKEN_TTL_SECONDS`)                                                                   | `POST /v1/auth/token` with the refresh token                                                              | Only at expiry: it is stateless. With a members store its roles and enrollment are re-read on every request anyway |
| Refresh token (`mrt_...`)           | 30 days idle, 90 days absolute (`SH_REFRESH_IDLE_TTL_SECONDS`, `SH_REFRESH_MAX_TTL_SECONDS`)         | Each use rotates it                                                                                       | `mocactl logout`, `logout --all`, a replay after the grace window, or, on `sandbox`, a refresh after unenrollment  |
| Session token (`scope: turn:write`) | 300 s (`SH_SESSION_TOKEN_TTL_SECONDS`)                                                               | `POST /v1/sessions/{id}/token`                                                                            | At expiry                                                                                                          |
| Sandbox token                       | 900 s (`SH_SANDBOX_TOKEN_TTL_SECONDS`, at most 3600; `SBX_TOKEN_TTL_MINUTES` on the sandbox service) | `POST /v1/sandboxes/{id}/token`, `mocactl sbx token` (`--renew-every S` prints a new one every S seconds) | At expiry, plus the relay's 30 s clock leeway; owner-only                                                          |
| Set-mode token                      | 300 s                                                                                                | Minted by `PUT /v1/sandboxes/{id}/mode` and `POST /v1/sandboxes/{id}/mode-token`                          | At expiry; owner-only, sent once right after it is minted                                                          |
| Turn grants                         | `MOCA_GRANT_TTL_S` (300 s), never past the turn's cap (`MOCA_TURN_MAX_S`, 1800 s)                    | The worker refreshes them during the turn                                                                 | At expiry only: no revocation list                                                                                 |
| Installer token                     | None: static                                                                                         | Not renewed                                                                                               | When the operator removes or rotates `SH_INSTALLER_TOKEN`                                                          |

For scripts, `mocactl auth token` prints a valid API token (exit 0; 3 when a login is needed; 4
when the control plane is unreachable).

## The `members` record stream

Every change made through `/v1/subjects` is a record on the `members` stream of the control
plane's provenance store, the same hash-chained store as the template and policy records, in
`SH_PROVENANCE_DIR`. Each record carries `schema: moca-provenance-record/1`, the stream, its `seq`,
its `kind`, `prev` (the previous record's sha256 digest, `null` for the first), `at` (UTC, whole
seconds), `subject` (who acted) and a `body`; a record is named by the sha256 of its canonical JSON
(`provenance.ts`). The stream holds these two kinds, and they appear on no other stream:

| Change   | `kind`   | `subject` (who acted)              | `body`                                                                                                                         |
| -------- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Enroll   | `member` | The settings admin, or `installer` | `{subject, enrolled: true, before: false}`                                                                                     |
| Unenroll | `member` | The settings admin, or `installer` | `{subject, enrolled: false, before: true}`                                                                                     |
| Grant    | `role`   | The settings admin, or `installer` | `{subject, role: "admin", state: "granted", until (or null), before: "granted" or "none"}`                                     |
| Revoke   | `role`   | The settings admin, or `installer` | `{subject, role: "admin", state: "revoked", before: "granted" or "expired"}`                                                   |
| Lapse    | `role`   | `control-plane`                    | `{subject, role: "admin", state: "expired", until, before: "granted"}`, written once, at the first request that sees it lapsed |

(`member-handlers.ts`, `members.ts`.) A change that changes nothing writes no record, and the
route answers `record: null`. A change that does answers with its record's digest. The record is
appended **before** `members.json` is replaced, so a crash between the two leaves a record for a
change the store does not hold, never the reverse, and a retry appends a second record: read the
stream as a log of attempted changes, and `GET /v1/subjects` as what is in effect.

To check the chain offline, `deploy/sbx/template-onboarding/verify-provenance.py EXPORT.json
[--head STREAM=sha256:HEX ...]` needs only Python 3 and a provenance export: it checks every
record's digest, each stream's `seq` and `prev` chain up to its head, and that `member` and `role`
records sit on `members` only. It exits 0 when verified, 1 when a check fails, 2 on a usage error.
Pass `--head members=<digest>` with a head kept elsewhere to catch an export that dropped its
latest records. The control plane serves no export route.

## Design limits

- **Without a members store, revocation waits for the token.** An API token lives out its 15
  minutes, and a settings change reaches a login at its next refresh (after the restart that
  reads it). With a store, roles and enrollment are per request.
- **A removed user's sandbox token outlives the removal** by up to one token lifetime plus 30 s;
  see [runbook §9](../operate/sandbox-service/runbook.md#9-limits-operators-must-know).
- **`setup.sh` can't remove an API grant**: it lives in the store, on the volume. After removing an
  admin from the settings, check `GET /v1/subjects` for API admins too.
- **A login minted as a user acts as an admin** if its subject holds an API grant: check
  `GET /v1/subjects` before treating a login as user-only.
- **The `members` stream is the only trace of an API change**: read it, with
  `GET /v1/subjects`, in any access review. No redaction tool rewrites it, and it names subjects.
- **The installer token is a standing credential** with a settings admin's power over access, on
  no login and with no expiry.
- **No operator route** lists another subject's logins or ends them.
- **One role, no groups.** There are no per-template roles, no self-enrollment requests and no
  groups or tenants beyond one subject each.
- **Turn grants have no revocation list**: `MOCA_GRANT_TTL_S` is their revocation latency.
- **OIDC login needs one control-plane replica** (or a shared pending-login store), and its login
  starts are bounded per client address; see [OIDC login](../operate/oidc-login.md#configuring-the-control-plane).
