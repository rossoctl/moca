# ADR-0045: Test-user logins, gated by a shared secret, for unattended multi-user testing

- **Status:** Accepted (2026-10-28; implemented by #620) <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-10-26
- **Deciders:** aslom
- **Issue:** [rossoctl/moca#616](https://github.com/rossoctl/moca/issues/616)

## Context

Every login to the control plane is GitHub's device flow: a person reads a code and approves it in
a browser (ADR-0039 for what that login then becomes). That is right for real users and impossible
for anything unattended, and the cost is already in the tree.

`deploy/k8s/smoke.sh` cannot log in, so it mints an API token **inside the control-plane pod** with
the signing key:

```sh
s.mint({ sub: 'smoke:1', tenant: 'smoke:1', roles: [], scope: ['api'], ttlSeconds: 900 })
```

That is not a login. No refresh family is issued, so the rotation path of ADR-0039 is never
exercised; `identity.rolesFor()` never runs, so `SH_ADMIN_SUBJECTS` is not covered; no `login` entry
reaches the audit stream; and it needs `kubectl exec`, so a client holding only the control plane's
URL cannot do it. The smoke authenticates in a shape **no real user ever has**.

What cannot be tested at all is multi-user behaviour. The MU1 claims that matter most — each
subject spending only its own credential, and one user being refused another's session — would take
N GitHub accounts and N browsers, so they have no automated coverage above a single user.

The pressure is therefore: get a login that automation can perform, without inventing a second
notion of what a logged-in subject is.

## Decision

We will add an **opt-in test-user identity path**. When `SH_TEST_USERS=N` is set, the control plane
serves logins for N synthetic subjects `test:1` … `test:N` via `POST /v1/auth/test-token`, and
`mocactl login --test-user N` drives it.

The path is **gated by a shared secret**, `SH_TEST_USER_SECRET`, which the client must present and
the control plane compares in constant time. Configured exactly like `SH_TEST_USERS` — same
deployment, same sticky `setup.sh` setting — and required whenever test users are on.

The decision that carries the value: a test user is configured **identically to a GitHub user**.
The handler makes the same two calls as `completeDeviceAuth` — `deps.refresh.issue()` then
`loginBody()` — so token TTLs, refresh rotation and renewal, `rolesFor`, the ownership index, the
audit trail and credential storage cannot tell the two apart. Only the way identity is
_established_ differs. Industry practice for this is a mock or local IdP (Dex's mock connector,
`oauth2-mock-server`, MockServer's OAuth2 support); we take the same shape — a predefined set of
test identities — but implement it behind our own `IdentityProvider` seam rather than deploying a
server, because the seam already exists and `identity.ts` already anticipates a second provider.

### Alternatives considered

- **Pre-mint N tokens at boot** — tokens exist before anyone asks, cannot be re-obtained once
  expired, and must be surfaced in a log or Secret, which is a worse exposure than an endpoint.
- **A `MOCA_API_TOKEN` override in mocactl** — smallest change, but it skips the refresh machinery,
  so test users would _not_ be configured like GitHub users, defeating the purpose.
- **Run a real second IdP (Dex) for tests** — cleanest in the abstract, and the common industry
  answer, but it adds a deployable to the test path to avoid ~150 lines behind an existing seam.
  The same reasoning `identity.ts` records for not using Dex in slice 1.
- **No secret, relying on `SH_TEST_USERS` alone** — rejected on review: a test cluster is reachable
  from more places than its operators assume ("before the breach, there was a test environment"),
  and an unauthenticated endpoint that mints a login for an arbitrary subject is a privilege
  escalation for anyone who can route to the control plane, including a compromised sandbox.

## Consequences

- Positive: automation can log in as many users and exercise the real login, refresh, credential
  and isolation paths. `smoke.sh` can later drop its in-pod `mint` and reach the control plane over
  HTTP alone.
- Positive: a non-GitHub subject form now exists behind the seam, which is the groundwork for the
  generic `oidc` provider `identity.ts` already contemplates.
- Positive: the secret lives in a Secret of its own (`moca-test-users`), written only while test
  users are on and deleted when they go off, projected from an `optional` source. That falls out of
  a constraint worth recording: `credentialValue` treats an _empty_ credential file as an error and
  only an _absent_ one as "unset", so a required-but-empty key anywhere on this path crash-loops the
  control plane before `identity.ts` runs — and a leftover secret with test users off makes it
  refuse to boot. Absent is the only safe "off" state.
- Negative / accepted cost: a deployment with `SH_TEST_USERS` set has a login path that needs no
  human. On `--target ocp`, the shared-cluster target, it additionally needs
  `SH_TEST_USERS_ACK=i-know-this-is-not-for-production`, so a stale export or a sticky ConfigMap
  value cannot quietly keep that path alive where other people work. The mitigations are structural rather than advisory — 404 when unset (indistinguishable
  from an unrouted path), a required secret of at least 16 characters compared in constant time,
  `N` capped at 1000, the route not mounted on the sandbox profile at all, a boot refusal if
  combined with that profile, and a warning line at boot naming the count.
- Negative / accepted cost: `test:N` subjects can be named in `SH_ADMIN_SUBJECTS`, so a
  misconfigured test cluster can hand admin to a synthetic subject. Deliberate — it is what makes
  the admin path testable — but it is one more reason the secret is not optional.
- Later addition: the sandbox service takes a test-user login too, as
  `mocactl sbx login --test-user N`, and only on the `combined` profile — `POST /v1/auth/test-token`
  is declared `harness`, which `mountsOn` also mounts on `combined`, while the `sandbox` profile
  neither mounts it nor boots with `SH_TEST_USERS`. The boundary above is unchanged; what is new is
  that `mocactl` can now fill `sbx-auth.json` without a browser. A login is not a sandbox: on
  `combined` the sandbox routes check enrollment, so the operator must also put the subject in
  `SH_ALLOWED_SUBJECTS` (which admits `test:<n>`, unlike `/v1/subjects`) or `SH_ADMIN_SUBJECTS`.
- Follow-up owed: migrate `smoke.sh` off the in-pod mint; decide whether `mocactl` should grow a
  `--profile` flag, since today a second login in one `XDG_CONFIG_HOME` overwrites the first and the
  driver script works around it with a directory per user.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
