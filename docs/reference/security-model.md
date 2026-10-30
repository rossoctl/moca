# Security model

> **Preview.** Describes P6 on `main` as of 2026-10-13: what each component holds, who can reach it, and what is and
> is not enforced. Every claim comes from code or a manifest unless marked _(documented only)_ (a README, ADR or spec
> says so; I did not find it in code), _(designed, not built)_, or _(inferred)_. To report a vulnerability see
> [`SECURITY.md`](../../SECURITY.md); for a checklist see [Hardening](../operations/hardening.md).

## Read this first

1. **With `SH_REQUIRE_AUTH` not set to `true`, anyone who can reach port 8080 can run turns on the operator's model
   credential.** (The P5 design also had unauthenticated callers name a subject with `X-SH-Subject`; that flow is
   _designed, not built_: the header is read only for the `subject_conflict` check when a token is present.) Compose defaults to `false` and passes the operator's
   `ANTHROPIC_*` variables into the supervisor, so adding the control plane does not close this. The single-VM template
   and the Kubernetes manifest set it to `true`. `MOCA_TENANCY=multi` refuses to boot unless it is `true`, but no
   shipped deployment sets `MOCA_TENANCY`.
2. **Every shipped deployment runs credential "direct" mode.** The control plane returns the user's real model key to
   the supervisor's worker for the length of a turn, so a worker process shared between users holds every concurrent
   user's key. "Placeholder" mode needs an injector (`SH_INJECTOR_CONFIGURED=true`), and none is shipped.
3. **The control plane has no user allowlist.** Anyone with a GitHub account who can reach it can log in and create
   sessions. If the operator fallback is on, any such user can spend the operator's key.
4. **Container sandboxes do not isolate sessions or users from each other** (see [Isolation](#isolation-by-tier)).

## Components and what they hold

| Component              | Holds                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supervisor and workers | Redis URL (with a password on Kubernetes only); the relay exec token; the exchange token; the control plane's **public** keys; a user's real model key for the length of a turn (direct mode). Compose also holds the operator's `ANTHROPIC_*` |
| Control plane          | The Ed25519 signing key, the credential KEK ring, the exchange token, the operator's inference token (not wired on Kubernetes), sealed user credentials, refresh-token hashes, the ownership index, config bundles, the audit stream           |
| Relay                  | The sandbox attach token(s), the exec token, the Redis password (Kubernetes only)                                                                                                                                                              |
| Container sandbox      | The attach token. Not the exec token, the Redis password or the MU1 keys                                                                                                                                                                       |
| Redis                  | Sessions, ownership, sandbox records (which decide where a turn executes), leases, hashed refresh tokens, audit streams, bundles                                                                                                               |

Tool commands run in a sandbox with an explicit environment that strips the worker's own settings
(`SANDBOX_TOKEN`, `RELAY_ADDR`, `RELAY_TLS`, `RELAY_CA_FILE`, `SH_*`, `MOCA_*` and others; any other `RELAY_`-prefixed name is not stripped). But commands run as the same Unix user as the sandbox
worker, so its token remains readable through `/proc` _(documented only; inferred from the shared uid)_. The
container tier uses one shared attach token, so a compromised container sandbox holds the credential for all of them.

### Who can reach what (Kubernetes)

| Port                  | Reachable from                                                                                                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supervisor 8080       | No pod (no ingress rule). Port-forward and, on OpenShift, the TLS sidecar over loopback bypass the policy                                                                                                                                                                                           |
| Supervisor admin 8081 | **Any pod in `moca`**, and on the single-namespace OpenShift target (`ocp-single`) also the **sandbox** pods, because that overlay removes the separate namespaces. Bound to all interfaces so the kubelet can probe it; unauthenticated; `/metrics` echoes an allowlisted slice of the environment |
| Control plane 8080    | The supervisor pods; on OpenShift also the router. The whole listener, including `/internal/credentials`, is exposed through the Route; that route is protected only by the exchange bearer                                                                                                         |
| Relay attach 9443     | Pods labelled `app=moca-sandbox` in `moca-sandbox`                                                                                                                                                                                                                                                  |
| Relay exec 9444       | The supervisor pods                                                                                                                                                                                                                                                                                 |
| Redis 6379            | Supervisor, relay and control plane, which share one password                                                                                                                                                                                                                                       |
| Sandbox               | No ingress. Egress to the relay, DNS, and the internet except private, CGNAT and link-local ranges                                                                                                                                                                                                  |

Default-deny applies in both directions in `moca`, `moca-sandbox` and `moca-credentials`. It only works on a CNI that
enforces NetworkPolicy; on one that does not, every row above is open. Because the three components share one Redis
password, a compromised worker could rewrite the ownership index _(inferred)_; the VM README says whoever can write it
can make another user's session their own.

The control plane has no rate limiting; its only caps are the request body size (64 KiB by default, 12 MiB for config bundles) and the bundle byte quota (429 `bundle_quota_exceeded`). A credential's
`endpoint` is accepted as any absolute http(s) URL with no private-range check, and the supervisor's egress rule is
`0.0.0.0/0:443`, so a user-supplied endpoint can aim a worker at in-cluster port-443 targets _(inferred)_.

## Authentication and authorization

### Tokens

All JWS and refresh tokens are issued by the control plane; the data plane gets only public keys, so a compromised harness can verify
tokens but not mint them. No credential travels in a token.

| Token          | Scope                       | Lifetime                       | Notes                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API token      | `api`                       | 15 minutes (default)           | Stateless and never revoked, so its lifetime is the revocation latency                                                                                                                                                                                                                                                                                             |
| Session token  | `turn:write`, carries `sid` | 5 minutes (default)            | Re-minted per session                                                                                                                                                                                                                                                                                                                                              |
| Refresh token  | opaque (`mrt_...`)          | 30 days idle, 90 days absolute | Stored hashed in Redis, except that during the grace window the grace key holds the **plaintext** successor so a replay can be answered: anyone who can read Redis sees each new refresh token for up to 30 seconds (`SH_REFRESH_REUSE_GRACE_SECONDS`, capped at 300). Rotates on every use; replaying a superseded token after the grace revokes the whole family |
| Exchange token | shared bearer               | none                           | Used by workers to call `/internal/credentials`; compared in constant time                                                                                                                                                                                                                                                                                         |

Tokens are EdDSA (Ed25519) JWS with `aud: harness`. A session token for one session cannot drive another
(`session_mismatch`), and an `X-SH-Subject` that differs from the token's subject is refused (`subject_conflict`). A
present but invalid token is refused even when `SH_REQUIRE_AUTH` is off. The `/workloads` routes require an API
token regardless. Reads of run status verify the token locally and do not consult the control plane, so a deleted
session's token can still read run status until it expires _(inferred)_.

### Identity and roles

A user is `github:<numeric id>` from the GitHub device flow. `admin` comes only from `SH_ADMIN_SUBJECTS`, re-evaluated
at each refresh. Admin has two powers: listing another user's sessions (`?owner=`) and deleting any config bundle. It
does not bypass session ownership. Another user's session answers 404, never 403, so ids cannot be probed.

A `403 single_tenant_deployment` appears in specs and the VM README but not in the code _(designed, not built)_.

### Relay tokens

Attach is fail-closed: an empty or missing token never admits. The expected token is, in order, a file in
`SH_RELAY_TOKEN_DIR`, then `SH_RELAY_TOKEN_<id>`, then `SH_RELAY_TOKEN`. The exec token is required, the relay refuses
to boot if it equals any sandbox token, and the exec listener is separate (loopback on a VM, the brain network in
Compose, a cluster service on Kubernetes). Container sandbox ids contain dashes, so they use the shared token. Anyone
holding it can attach under any id that is not currently attached and advertise its own tier label, and would then
receive the executions routed to that id _(inferred)_.

With `MOCA_ATTACH_PUBLIC_KEYS` set, the `moca.dev/workload` and `moca.dev/owner` labels are trusted: the relay sets them
only from a signed `moca-attach+jwt` attach token, and strips them from every `Hello` admitted by a relay token. The
token is per workload: it admits only ids `<wl>-<ordinal>` with the ordinal below its `n`, and its `exp` is required;
the relay refuses an expired one and closes an attach stream when its token expires. Model code inside a workload
sandbox can read that workload's token, so it can register an absent ordinal of the same workload until `exp`; that
reaches no other workload or user. The tier and capability labels a sandbox sends are still not trusted. Selection
keeps workload runs on sandboxes whose workload and owner labels both match the run's, keeps other runs off them,
and the relay refuses an Exec whose `workload` does not match its sandbox's. That
check catches routing bugs, not a compromised worker: the worker fills in the field
([workload sandboxes spec §3.3](../specs/2026-10-16-workload-sandboxes-design.md)). The relay ignores a sandbox
caller's `workload` field, so its Exec is refused on every workload sandbox: by design, sandbox
callers cannot reach workload sandboxes.

## Model credentials

1. A user stores a credential (`PUT /v1/credentials/{name}`). The API is write-only: nothing reads a value back.
2. It is sealed with AES-256-GCM under the first key of `SH_CREDENTIAL_KEK`, with the subject and name as
   authenticated data, so a relabelled ciphertext fails to open.
3. On each turn the worker verifies the session token locally, then calls `/internal/credentials` with the exchange
   bearer. The control plane checks the session's owner and returns the credential for that turn.
4. The worker puts the key in the request headers only; its environment holds a constant sentinel. If the control
   plane is unreachable the turn fails; there is no fallback to the environment.
5. Under `MOCA_TENANCY=multi` the worker also scrubs every ambient provider credential from its environment at boot.

Stores: Kubernetes Secrets (one per user, in `moca-credentials`; only the secret field is sealed, while the kind,
consumer, destination, binding and endpoint sit in plaintext annotations), a file store (0700 directory, 0600 files,
single host), or Vault (the value is still sealed under the KEK; `VAULT_ADDR` may be plain `http://`; not wired by
`setup-vm.sh`). Encryption of etcd at rest is not configured by this repository.

The operator fallback is off by default, needs a token and a default endpoint or the control plane refuses to boot, and
applies only to a session created with no credential name. Each use is audited as `operator_fallback_used`. On Kubernetes the switch
(`SH_ALLOW_OPERATOR_FALLBACK`) is wired but the token (`SH_OPERATOR_INFERENCE_TOKEN`) is not, so enabling it makes the
control plane refuse to boot (#368).

### Where secrets live

| Path       | MU1 keys and tokens                                                                                                                                                                | Relay and Redis                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Kubernetes | One Secret, `moca-mu1`, holding all four values, so anyone who can read secrets in `moca` reads the signing key and the KEK; files at 0400 in the pods                             | Secrets via `secretKeyRef`; `requirepass` in a config file, not argv |
| Single VM  | Root-only files (0700 directory, 0600 files) loaded with `LoadCredential=`; all three units run as the same user, so a supervisor compromise reads the control plane's credentials | Plain `EnvironmentFile` lines (0640)                                 |
| Compose    | Environment variables from `.env` (written under `umask 077`)                                                                                                                      | Environment variables; Redis has no password                         |

`setup.sh` on Kubernetes passes secrets on stdin, not argv, and never rotates them. The MU1 keys are generated in a pod
whose log holds them for a few seconds; if `setup.sh` is killed the pod can be left behind (delete it).

## Isolation by tier

|                        | Container (Kubernetes)                                                                                                                                                | Container (single VM)                                                                                                                                                                            | Container (Compose)                                       | MicroVM (P4)                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process isolation      | Non-root uid 1001, all capabilities dropped, no privilege escalation, default seccomp, no service-account token; root filesystem **not** read-only; memory limit only | A podman container; **no** `--cap-drop`, `--read-only`, security options or limits                                                                                                               | A container; no capability, filesystem or resource limits | A Firecracker microVM per `Exec`, launched under the jailer (chroot and cgroup; the same uid/gid as the worker, which is root with the shipped unit) |
| Network                | NetworkPolicy: relay and public internet; private, CGNAT and link-local blocked (including cloud metadata)                                                            | Dedicated `isolate=strict` network; an input firewall drops traffic to the host except the relay port and DNS. **Forwarded traffic is untouched**: the internet and cloud metadata are reachable | Own network, routed to the internet                       | **No NIC**, no DNS: the guest cannot reach any network                                                                                               |
| Host service hardening | Pod Security `restricted` on the namespaces                                                                                                                           | systemd units with `ProtectSystem=strict`, `NoNewPrivileges`, a syscall filter                                                                                                                   | n/a                                                       | The `microvm-worker` unit has no `User=` and none of those directives; it runs as root                                                               |

### Not enforced on any tier

- **Sessions on one sandbox share a Unix user and filesystem.** The per-session directory is a naming convention, not
  a boundary, and the worker ignores the workspace key. Sandbox selection has no owner filter, so two users' sessions
  can land on the same container.
- **Egress is open** to the internet on every container path, and there is no credentialed-egress proxy.
- **No per-session grants.** Anyone holding the relay exec token can target any workspace key, including on the
  microVM tier, where the workspace key is the session id but is not bound to a user.
- **A silent workspace reset** (#338): idle reclaim deletes a workspace without telling the next turn.

### Designed, not built

The multi-user isolation design (MI1) lists signed per-session grants, a credentialed-egress proxy, owner-bound
sandboxes and bundle ACLs. Its registry status is "design, proposed". Only its first slice (hardening: the exec/attach
token split, the environment allowlist, the ambient-credential scrub, no sandbox means the turn fails, caller-supplied
`tenant` refused) is visible in code. The Z-track zero-trust credential plane is design-stage, apart from a static
single-tenant slice delivered for the Knative path.

If your users do not trust each other, run a separate deployment, or at least a separate sandbox set, per trust
domain.

### One process, many sessions

A worker serves many sessions, so process-wide state matters. The harness takes identity from the verified token on
every request, runs Pi with extensions, context files and skills switched off, and pins four pieces of process-wide Pi
state with tests rather than refactoring them, and documents a fifth (`fileMutationQueues`) unchanged. The design records residual hazards: a write error in the output guard
would exit the whole process (pinned unreachable in server mode), the project-settings trust gate defaults to open, and
a settings lock can busy-wait for up to about 200 ms. The worker's sentinel assignment to `ANTHROPIC_API_KEY` is also
process-wide, though it is the same constant for every caller. One subject cannot take every turn slot: the worker caps
each authenticated subject at `SH_TURNS_PER_SUBJECT` in-flight turns (default half the per-worker cap S), answering
`subject_quota_exceeded` with `Retry-After`; the count is per worker, so the host-wide bound is `cap/S`.

## Transport security

| Hop                                   | Encryption                                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client to supervisor (OpenShift)      | TLS by a ghostunnel sidecar behind a **passthrough** Route; server-side TLS only, no client certificates; a self-signed fallback certificate is generated if you do not supply one |
| Client to control plane (OpenShift)   | An **edge** Route: TLS ends at the router, plaintext to the pod                                                                                                                    |
| Client to anything else               | Plaintext HTTP. On a VM the supported access is an SSH tunnel or a firewall allowlist; an allowlist sends tokens and credentials in clear                                          |
| Supervisor to control plane           | **Plaintext HTTP** on every path. This hop carries the exchange bearer, the session token and, in direct mode, the real model key                                                  |
| Supervisor and sandboxes to relay     | Plaintext gRPC in-cluster, on the VM host and in Compose                                                                                                                           |
| External P4 host to relay (OpenShift) | TLS 1.2 or later through a sidecar; opt in with `RELAY_TLS=true` and `RELAY_CA_FILE`. Not available on other targets                                                               |
| Components to Redis                   | Plaintext TCP                                                                                                                                                                      |

The supervisor must be reached at layer 4 only. An Ingress, edge Route or mesh sidecar in front of it defeats the
per-connection hand-off and the turn cap; that is a correctness constraint, not a confidentiality one.

## Audit and logging

The control plane records credential issuance, the operator fallback, session create and delete, credential writes,
bundle uploads and refresh-token decisions in a Redis stream, with names and ids but never secret values. Errors leave
the control plane as opaque codes. A search of the obvious paths found no logging of tokens or headers, but that was a
grep, not an audit. See [Observability](../operations/observability.md#the-audit-stream).

## Supply chain

Every GitHub Action is pinned to a commit SHA, and Dependabot covers actions, npm, Docker and Go modules. Pull requests
run dependency review (informational: it does not block), Trivy in filesystem mode, CodeQL, ShellCheck and hadolint on
the root `Dockerfile` only. Scorecard runs weekly. Images are pushed to `ghcr.io/rossoctl/*` and **are not signed or
attested**. The harness image has no `USER` line (the manifests impose non-root), uses floating base tags and includes
`kubectl` for the deprecated Knative path. Redis and the OpenShift TLS sidecar are pinned by digest; the harness and
remote-worker images are `:latest` unless you pass `--image` (harness) and `--sandbox-image` (remote worker; the
VM uses `SANDBOX_IMAGE`). Valkey is digest-pinned only in the Kubernetes manifests; the VM and Compose use
`valkey/valkey:9-alpine` by tag.

## Known gaps in `SECURITY.md`

`SECURITY.md` says dependency vulnerabilities are detected with `pnpm audit` (no workflow runs it), and describes
non-root, read-only-rootfs, capability-dropped containers on Kubernetes (true of every container, except that the sandbox's
root filesystem is writable). Treat this page as the more accurate description until `SECURITY.md` is corrected.
