# Upgrades

> **Preview.** For P6 on Kubernetes ([`deploy/k8s`](../harness/kubernetes.md)). The repository documents no
> rollback procedure; what is below is what the scripts and manifests do.

## Upgrading means passing a new image

`deploy/k8s/setup.sh` is idempotent: re-running it with the same inputs only reconciles. It never rotates a secret,
and with nothing changed no pod restarts. **On the base and OpenShift targets, re-running with the default
`:latest` upgrades nothing**: the pod template is unchanged, so nothing rolls and no newer `latest` is pulled (a pod
that restarts for another reason may re-pull it, by chance). An upgrade there means passing a new `--image`, a tag or,
better, an `@sha256` digest. On Kind a rebuilt image rolls the pods (below). A re-run reads the stored inputs, applies the whole kustomization in one `kubectl apply -k`, then waits for each component
in order: Redis, relay, supervisor, control plane (only if a GitHub client id is set), sandboxes. There is no
per-component ordering inside the apply itself.

Inputs are **sticky**: a variable you leave unset keeps its stored value, and one set to the empty string usually
clears it. Exceptions: an empty `SH_SANDBOX_COUNT` counts as unset and keeps the stored count; `--image` and
`--sandbox-image` cannot be empty (reset them by passing the default explicitly); `SH_WAIT_SECONDS` is not sticky.
They live in two ConfigMaps you can inspect:

```bash
kubectl -n moca get configmap moca-settings moca-setup -o yaml
```

## Which image runs

| Target     | Images                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base / OCP | `ghcr.io/rossoctl/moca:latest` and `ghcr.io/rossoctl/moca-remote-worker:latest`; `--image` and `--sandbox-image` override them and are stored. A `@sha256` reference becomes a digest pin |
| Kind       | Locally built `dev.local/...:local`. `setup.sh` stamps the image id on the pod templates, so a rebuilt image rolls the pods and an unchanged one does not                                 |

Redis and the OpenShift TLS sidecar are pinned by digest. **The harness image is not digest-pinned by default** and
is `:latest`; pass `--image <ref>@sha256:...` to upgrade and to make the upgrade repeatable. An old `latest` may
predate `/readyz`, in which case the supervisor never becomes Ready.

## How each component rolls

| Component     | Strategy                                                                                             | What you will see                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supervisor    | Rolling, `maxUnavailable: 0`, `maxSurge: 1`                                                          | A new pod must become Ready first; in-flight turns on the old pod get the drain below                                                                |
| Relay         | `Recreate`, one replica; runs the **harness image**                                                  | **Every harness image change recreates it**: all sandboxes and P4 hosts detach and in-flight turns fail and are retried                              |
| Control plane | One replica, default strategy (rolling, 25%/25%: one extra pod, none unavailable); grace period 30 s | The new pod must pass `/readyz` before the old one goes, so no planned gap in login or exchange (it runs 0 replicas when no GitHub client id is set) |
| Redis         | StatefulSet, one replica                                                                             | See [Redis backup and recovery](redis-backup-recovery.md)                                                                                            |
| Sandboxes     | StatefulSet, rolling one pod at a time (highest ordinal first), each waiting for Ready               | Pod-local workspaces are lost: a rolled or restarted sandbox resets every container session's workspace **silently**                                 |

A settings change rolls the supervisor and control plane through a settings-hash annotation, except
`SH_WORKSPACE_IDLE`, which rolls only the sandboxes (they read it, and nothing else does). Because the relay
runs the harness image, any `--image` bump recreates it. The first apply of a P6.3 release also recreates the relay and
rolls every sandbox on **every** stack, tiered or not (new environment variables on the relay and sandboxes). Do both
at a quiet time.

## What an in-flight turn experiences

On a supervisor rollout the pod waits for the endpoint to leave the Service (5 seconds), then drains: workers stop
taking turns, the listener closes, and the supervisor waits up to **20 seconds** for in-flight turns. A detachable
turn still running at **15 seconds** is aborted with the message `harness restarting`. The 120-second pod grace
period is only an outer bound. Practically:

- A turn longer than about 15 to 20 seconds does not survive a rollout. The committed session does; the work in
  that turn is lost.
- Attach streams on a draining worker end without a terminal frame; a client re-attaches to another worker.
  I did not verify that `mocactl` does this automatically.
- The supervisor is PID 1, so its exit takes the workers with it.

## Version skew

- **Harness before control plane.** Config bundles require the harness to be upgraded first: a harness older
  than v0.5.0 ignores `configRef` on the interactive turn path (prompt leaves have applied it since v0.3.0), so
  turns run without the skills and report no error. Every later harness applies it, so the order matters only when upgrading from before v0.5.0 or to a release that changes the
  bundle format ([#510](https://github.com/rossoctl/moca/issues/510)). Nothing enforces this order, and the
  supervisor, control plane and relay use the same image, so one `--image` bump moves all three and they roll in
  parallel (the rule is in [ADR-0038](../../adrs/0038-mocactl-config-bundle-promotion.md) and the
  [promote guide](../../harness/how-to/promote-claude-workflow.md)). For a release whose notes say it changes config-bundle handling, roll the supervisor
  first (see below). Do not split the image to get this ordering.
- **Tier lists must match.** `SH_SANDBOX_TIERS` and `SH_SANDBOX_DEFAULT_TIER` are read by both from the same
  ConfigMap.
- **Redis schema version.** Redis holds `sh:schema-version`, written by the first control plane, worker or relay to
  start. The check runs in the background once the process is serving: it retries until Redis answers, and a process
  that finds a version newer than it knows then exits with the reason in its log. A rollback past a schema change is
  not supported: the older release exits once Redis answers only if the newer one raised the stored version, which
  each release that bumps it decides ([change policy](../../reference/change-policy.md#version-markers)).
  There is no migration tool: new fields are handled by tolerant reads, and every release so far writes version 1.
  An absent key, with any `sh:` data, means version 1. The key has no TTL: keep Redis on a `noeviction` or
  `volatile-*` eviction policy (an `allkeys-*` policy can evict it), and after a `FLUSHALL` or a restore that lost
  it, re-stamp it with the data's version (`SET sh:schema-version 1` today), since the next process to start
  otherwise stamps its own. A Redis that refuses writes still has an existing stamp checked; on an absent key the
  refused write is logged once and retried, and the process runs on. The credential envelope is versioned too (`v1.`).
- **Config-bundle format.** A bundle carries its format version (`format.json`). The control plane refuses to store a
  format newer than it knows (`400 invalid_request`), and the harness refuses to apply one (a turn answers
  `422 config_bundle_unsupported`), so a client upgraded first fails loudly, with the reason in the response. Because
  the marker is bundle content, a workflow promoted again with the first release that writes it gets a new digest;
  bundles already stored keep theirs, and sessions naming them keep working.
- No wire-version negotiation exists. `GET /v1/discovery` returns the control plane's `version`.

### Rolling the harness before the control plane

_Unverified: this uses plain Kubernetes commands and has not been run against `deploy/k8s`._ Pause the control
plane's rollout, apply the upgrade, and resume the control plane from a second terminal once the supervisor is Ready:

```bash
# terminal 1
kubectl -n moca rollout pause deployment/moca-control-plane
deploy/k8s/setup.sh --target kind --skip-build        # your usual flags, including --image

# terminal 2, in parallel
kubectl -n moca rollout status deployment/moca-supervisor
kubectl -n moca rollout resume deployment/moca-control-plane
```

`setup.sh` waits on the control plane for up to 300 seconds. Resuming it from the second terminal lets the script finish
normally, so its sandbox and presence checks still run. If you cannot resume in time, `kubectl rollout status` on a
paused Deployment is expected to keep waiting and then fail at that timeout; the script then skips the sandbox and
presence checks, and you should resume and run them yourself:

```bash
kubectl -n moca-sandbox rollout status statefulset/moca-sandbox
kubectl -n moca exec redis-0 -- sh -c 'redis-cli HLEN sh:sandbox:records'   # should equal SH_SANDBOX_COUNT
mocactl doctor
```

For releases that do not change bundle handling, skip all of this: the window is short and only affects sessions
that use a promoted bundle.

## Upgrade notes

Changes that alter a default or what a re-run of `setup.sh` writes ([change policy](../../reference/change-policy.md),
rule 5).

- **Rotating a `moca-mu1` key rolls the control plane ([#939](https://github.com/rossoctl/moca/issues/939)).** The
  sandbox service's settings hash now covers `moca-mu1` (the signing key, the janitor and installer tokens, and on
  the combined profile the exchange token and the credential KEK), so deleting a key and re-running `setup.sh`
  rotates it and rolls the pods that read it. The first `setup.sh` run after the upgrade rolls the control plane
  once (and, on the combined profile, the supervisor), even with no other change.
- **On the combined profile, the installer token becomes live
  ([#938](https://github.com/rossoctl/moca/issues/938)).** `deploy/sbx/setup.sh` already generates `SH_INSTALLER_TOKEN`
  into `moca-mu1` on both profiles; from this upgrade the combined control plane mounts and reads it, so a combined
  deployment that ran that `setup.sh` gains a working members-API bearer (the `/v1/subjects*` routes, as a settings
  admin). It can grant the admin role (`PUT /v1/subjects/{subject}/roles/admin`), so it reaches admin powers in one
  indirect step through that subject's own login: treat it as admin-equivalent. If the generated token may have been shared, rotate it (delete the key and re-run `setup.sh`) before
  upgrading; the mount needs the key present, so leave one in place.
- **A turn is told when its session's workspace was reset
  ([#338](https://github.com/rossoctl/moca/issues/338)).** The harness keeps a `.moca-session` marker in each
  session's workspace and checks it at every turn's start: one extra Exec per turn, about 2 ms on the container
  tier and one VM acquire (a standby restore, then its replenish) on the microVM per-exec tier. A reclaimed
  workspace is reported as `workspace_reset` with reason `reclaimed`; a `mocactl` from before harness API 1.7.0
  prints that as its "sandbox is gone" message, so upgrade `mocactl` to see the right one. In a git repository
  (a worktree or submodule included) the marker is added to the repository's `info/exclude`, so `git status`,
  `git add -A` and `git clean -fd` leave it alone.
- **Container sandboxes keep an idle workspace for 8 hours, not 30 minutes
  ([#338](https://github.com/rossoctl/moca/issues/338)).** The first `setup.sh` run after the upgrade writes
  `SH_WORKSPACE_IDLE=8h` to `moca-settings` and to a new ConfigMap, `moca-sandbox-settings`, in the sandbox
  namespace, and the sandbox pods read it. That run **rolls every `moca-sandbox` pod** once (a new env entry and a
  `moca.dev/workspace-idle` annotation on the pod template), which resets every container session's workspace,
  silently, so run it at a quiet time. The control plane and the supervisor do not roll for it. Workloads' sandboxes
  take the new value when their pods next start. From then on, an idle session's files stay on the node's disk up to
  16 times longer: disk is not admission-controlled, and the idle sweep is the only thing that frees it. To keep the
  old behavior, re-run with `SH_WORKSPACE_IDLE=30m`. A manifest applied without `setup.sh` has no
  `moca-sandbox-settings` and keeps the worker's 30-minute default. The reset is still silent when the sweep fires,
  and no session end frees its workspace early: both stay open in #338.

- **Login starts are bounded per client address (oidc only, [#716](https://github.com/rossoctl/moca/issues/716)).**
  Besides the 10,000 live login states in total, one client address may now hold at most
  `SH_OIDC_MAX_PENDING_PER_SOURCE` (default **20**); past that, that address gets `429 quota_exceeded` while other
  addresses still log in. The address behind an OpenShift Route is the last `X-Forwarded-For` entry, so upgrade by
  **re-running `setup.sh`** with the new `--image`: that run writes `SH_TRUSTED_PROXY_HOPS=1` to `moca-settings` and
  pins `haproxy.router.openshift.io/set-forwarded-headers: append` on every Route to the control plane, and the
  trust relies on both. An image changed any other way leaves the key unset, which means 0, and every login then
  keys by the router's address: the deployment as a whole gets 20. Users behind one NAT address share one bucket;
  raise the bound with `SH_OIDC_MAX_PENDING_PER_SOURCE` (sticky, `0` turns it off). GitHub logins are unchanged.
  On `deploy/vm` behind its SSH tunnel every client arrives from `127.0.0.1`, so the default caps the whole VM at
  20: set `SH_OIDC_MAX_PENDING_PER_SOURCE=0` in `control-plane.env` there (the env example shows the line).
  Outside `deploy/k8s`, if you enable oidc behind a proxy that appends to `X-Forwarded-For`, set
  `SH_TRUSTED_PROXY_HOPS` to the number of such proxies. A request whose header holds fewer entries than that keys
  by its socket peer. A custom `PendingAuthStore` needs no change: its `put` may still answer `true`/`false` (parked,
  or the total cap's refusal); it enforces the per-source bound only once it answers `'source_full'`.

## Rolling back

No procedure is documented. Mechanically, re-running `setup.sh` with an older `--image` rolls the Deployments back,
and plain `kubectl rollout undo` also works. Redis data carries a schema version (above): a rollback
between releases that share it needs no step, and one past a schema change is not supported (and is refused once
a release raises the stamp). Rollback is otherwise
untested.

## Availability during a node drain

There is no PodDisruptionBudget, anti-affinity or topology spread in the manifests, and Redis, the relay and the
control plane are single replicas. Drain nodes one at a time and expect a gap.
