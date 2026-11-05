# Multi-user

> **Preview.** Describes the multi-user control plane (MU1) on `main` as of 2026-10-12. The stronger
> per-session isolation in the MI1 design is mostly not implemented; see the end of this page.

Several people can share one deployment. The **control plane** is the part that knows who they are: it
logs users in, records which sessions each owns, stores their credentials, and issues the short-lived
tokens the data plane trusts. `mocactl` is its terminal client.

## Identity and roles

Login is the GitHub OAuth device flow; a user is identified as `github:<id>`. A subject listed in
`SH_ADMIN_SUBJECTS` has the `admin` role, re-evaluated at each refresh. In the code the admin's powers are
narrow: list another user's sessions (`?owner=`) and delete any config bundle. An admin does **not** bypass
session ownership.

## Tokens

| Token         | Scope        | Default lifetime                | Used for                                       |
| ------------- | ------------ | ------------------------------- | ---------------------------------------------- |
| API token     | `api`        | 15 minutes, refreshable         | Control-plane calls (and harness `/workloads`) |
| Session token | `turn:write` | 5 minutes, bound to one session | Turns on the data plane                        |
| Refresh token | n/a          | 30 days idle, 90 days absolute  | Obtaining new API tokens                       |

Refresh tokens rotate on use, and replaying an old one is detected. A session token carries the
session id, and the data plane enforces one rule on a turn: the token's session must equal the request's.
Setting `SH_REQUIRE_AUTH=true` makes a token mandatory; with it off, a deployment can also serve
unauthenticated calls on its operator credential, which suits a single-user trial and nothing else.

## Credentials

A user stores an inference credential with `mocactl credentials add`. The store is **write-only**: there is
no read-back, `GET /v1/credentials` returns names, kinds, consumers, hosts, endpoints and bindings (never a secret), and the secret is read
from stdin so it stays out of shell history. Secrets are encrypted per subject (AES-256-GCM, with the
subject and name as authenticated data) under a key ring, `SH_CREDENTIAL_KEK`, newest key first. Storage
is a file store on a VM or in Compose, Kubernetes Secrets on a cluster, or Vault.

On each turn the data plane presents the session token to the control plane and receives, for that turn
only, the credential to use, the model endpoint, the session's config bundle and its sandbox tier. In
`placeholder` mode the worker receives an inert placeholder and a gateway injects the real key; in `direct`
mode the worker holds the real key for the turn. Which mode applies depends only on whether an injector is
configured; `MOCA_TENANCY=multi` does not force placeholder mode. The credential is chosen when the session is created
and a session that names one never falls back to another.

An operator can opt in to a fallback key for users who have none
(`SH_ALLOW_OPERATOR_FALLBACK`); it is audited as `operator_fallback_used`.

## What a user can see

A user sees their own sessions only. Another user's session answers **404**, exactly like one that never
existed, so ids cannot be probed. 403 appears only where a role is missing (`?owner=` without admin,
deleting someone else's bundle). Deleting a session also removes its log and stored leaf results.

Config bundles are content-addressed and counted against a budget (16 MiB per user, 64 MiB in total by
default, 8 MiB per bundle), expiring after 30 days unless used. Using a bundle needs only its digest, which
acts as a bearer capability. Deleting one requires being its uploader (the budget entry records the first
uploader) or an admin; a bundle stored by the older `/promote` path has no budget entry, so only an admin
can delete it.

## Isolation between users today

- Each user's turn is authenticated and their credential is issued per turn.
- A process shared between users holds no ambient credential under `MOCA_TENANCY=multi`, and the harness
  refuses a turn with no sandbox.
- Sandboxes are **not** bound to users: a container sandbox serves whichever sessions are placed on it, and
  there is no per-session sandbox grant. The MI1 design adds signed per-session grants, a credentialed
  egress proxy and one-container-per-user sandboxes; none of that is implemented.

If your users do not trust each other, run one deployment (or at least one sandbox set) per trust domain
until MI1 lands.
