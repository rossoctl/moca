# Configuration reference

> **Preview.** Describes the P6 runtime as of `main` on 2026-10-12. Variable names keep their
> historical prefixes (`SH_*`, `KAGENTI_*`, `MOCA_*`); they are listed as they exist in the code.
> Each row is taken from the code that reads it. The deployment READMEs ([`deploy/vm`](../../deploy/vm/README.md),
> [`deploy/k8s`](../../deploy/k8s/README.md), [`deploy/compose`](../../deploy/compose/README.md),
> [`deploy/microvm`](../../deploy/microvm/P4-ON-P6.md)) say how each path sets these; the env
> templates are in `deploy/vm/env/*.env.example`.

## Conventions

- **Secret** means the value is a credential. On a VM, `SH_EXCHANGE_TOKEN`,
  `SH_SESSION_TOKEN_PRIVATE_KEY` and `SH_CREDENTIAL_KEK` are systemd credentials
  (`LoadCredential=`), as is `SH_OPERATOR_INFERENCE_TOKEN` when configured by `setup-vm.sh`. Setting
  one of those in an env file as well makes its consumer refuse to boot. `MOCA_RELAY_EXEC_TOKEN` and
  `SH_RELAY_TOKEN` are plain `EnvironmentFile` lines (mode 0640), not credentials. Docker Compose
  passes all of them as plain env.
- **Blank values.** A blank line (`X=`) means "use the default" for most numeric knobs. Exceptions:
  blank `SH_TURNS_PER_WORKER` refuses to boot, and a blank `SH_MODEL` is kept as an empty string
  rather than defaulting.
- **Strict vs lenient parsing.** The supervisor's own `config.ts` (including `SH_ROUTING_POLICY`) and
  the control plane's byte-budget and URL settings refuse a bad value. The control plane's numeric
  TTLs (`intEnv`) silently fall back to the default, and accept forms such as `1.9`, `1e4` and
  `0x1F90` with no upper bound. Several worker settings (`SH_STATS_INTERVAL_MS`, the
  `KAGENTI_SANDBOX_*` lease and affinity timings, `KAGENTI_SYNC_SATURATION_*`) also fall back
  silently, so a typo produces no error. The Go microVM worker refuses a malformed
  `WORKER_MAX_CONCURRENT`.
- **`CREDENTIALS_DIRECTORY`.** When systemd (or the K8s manifests) sets it, the control plane reads
  all four of its secrets from that directory first and falls back to the same-named env var; both
  present is fatal.
- **Values that must agree across components** are called out in the rows (relay and supervisor
  ports and tokens, tier names, affinity TTL).

## Supervisor (parent process)

`packages/supervisor/src/config.ts`.

| Variable                       | Default                         | Required / notes                                                                                     | Meaning                                            |
| ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `SH_TURNS_PER_WORKER`          | none                            | **Required**, at least 1; blank refuses to boot                                                      | S, the in-flight turn cap per worker               |
| `SH_TURNS_PER_SUBJECT`         | half of S, min 1                | Integer at least 1; a malformed value falls back to the default; unset with no S means no quota      | Per-subject in-flight turn cap per worker (#360)   |
| `PORT`                         | `8080`                          | Integer 0-65535                                                                                      | Data-path listen port                              |
| `SH_ADMIN_PORT`                | `8081`                          | Must differ from `PORT` unless 0                                                                     | Admin listener (`/metrics`, `/healthz`, `/readyz`) |
| `SH_ADMIN_HOST`                | `127.0.0.1`                     | IP literal only. The admin listener is unauthenticated; widen it only behind your own access control | Admin bind address                                 |
| `SH_WORKERS`                   | CPU count available to the unit | Integer at least 1                                                                                   | W, the worker count                                |
| `SH_ROUTING_POLICY`            | `leastInFlight`                 | `leastInFlight` or `stickyBySession`; others refuse to boot                                          | How accepted sockets are routed                    |
| `SH_WORKER_RESTART_BACKOFF_MS` | `250`                           | Integer at least 0                                                                                   | Backoff before restarting a dead worker            |

## Worker: auth, tenancy and Redis

The worker is `packages/knative-server/src/worker.ts` (the package name is historical). It validates
`SH_SANDBOX_DISCOVERY`, `SH_REMOTE_SANDBOX` and the tier settings at boot and exits on failure.

| Variable                       | Default                   | Required / notes                                                                                 | Meaning                                                                  |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `SH_REQUIRE_AUTH`              | off (only `true` enables) | Required `true` when `MOCA_TENANCY=multi`. A bad token is refused even when off                  | Every turn needs a control-plane session token                           |
| `SH_SESSION_TOKEN_PUBLIC_KEYS` | empty                     | Malformed value fails the boot. VM: `setup-vm.sh` writes it once                                 | The control plane's public keyset, `<kid>:<base64 SPKI>`                 |
| `SH_CONTROL_PLANE_URL`         | unset                     | No boot check. VM preset `http://127.0.0.1:8090`                                                 | Where the worker reaches the control plane for credential exchange       |
| `SH_EXCHANGE_TOKEN`            | unset                     | **Secret.** Env plus credential file, or an empty file, fails the boot                           | The workers' bearer for the control plane's exchange hop                 |
| `MOCA_TENANCY`                 | `single`                  | `single` or `multi`; a near-miss spelling of the name throws. `multi` refuses `SH_LOCAL_TOOLS=1` | `multi` scrubs ambient provider credentials. No shipped template sets it |
| `SH_LOCAL_TOOLS`               | off                       | Refused under `multi`                                                                            | Single-tenant dev opt-in: run tools in the worker                        |
| `REDIS_URL`                    | `redis://127.0.0.1:6379`  | URL may carry a password                                                                         | Sessions, leases, affinity, sandbox records, turn log, bundles           |
| `CREDENTIALS_DIRECTORY`        | unset                     | systemd sets it; the K8s manifests set it by hand to `/run/credentials`                          | Where credential files are read first                                    |
| `MOCA_VERSION`                 | `dev`                     |                                                                                                  | Reported version, baked in at image build                                |
| `SH_STATS_INTERVAL_MS`         | `1000`                    | Invalid or non-positive falls back                                                               | Pace of advisory stats from workers                                      |

## Worker: sandbox selection, affinity and tiers

| Variable                            | Default                                        | Required / notes                                                                                                                                                                                           | Meaning                                                                   |
| ----------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `SH_REMOTE_SANDBOX`                 | off (only `1` enables)                         | `SH_SANDBOX_DISCOVERY=records` without `1` fails the boot                                                                                                                                                  | Use sandbox records mirrored from the relay                               |
| `SH_SANDBOX_DISCOVERY`              | `both`                                         | `pods`, `records` or `both`. All P6 templates use `records`                                                                                                                                                | Which sandbox inventories are consulted                                   |
| `SH_RELAY_ADDR`                     | `sandbox-relay.default.svc.cluster.local:8443` | Must reach the relay's `MOCA_RELAY_EXEC_ADDR` listener (the same port, not necessarily the same literal address: Kubernetes and Compose bind one address and dial a service name), **not** its attach port | Address of the relay's `SandboxExec` listener                             |
| `MOCA_RELAY_EXEC_TOKEN`             | none                                           | **Secret.** Required when the exec client is built. Must equal the relay's                                                                                                                                 | The workers' credential for the relay's `SandboxExec`                     |
| `KAGENTI_SANDBOX_POOL_SELECTOR`     | unset                                          | Templates set `app=sandbox`. If unset, the single-pod path is used. When set, the next three variables are read on the pool/records path                                                                   | Label selector for the sandbox pool                                       |
| `KAGENTI_SANDBOX_NAMESPACE`         | `default`                                      |                                                                                                                                                                                                            | Namespace for the kubectl pool listing                                    |
| `KAGENTI_SANDBOX_CONTEXT`           | unset                                          |                                                                                                                                                                                                            | kubectl context                                                           |
| `KAGENTI_SANDBOX_CWD`               | `/workspace`                                   | **Must equal the sandbox worker's `SH_WORKSPACE_ROOT`**, or sessions do not get their own `<root>/<sessionId>` directory                                                                                   | Working directory in the sandbox                                          |
| `KAGENTI_SANDBOX_CAP`               | `20`                                           | Invalid or below 1 falls back. Templates set `4`                                                                                                                                                           | Soft cap on leases per sandbox                                            |
| `KAGENTI_SANDBOX_LEASE_TTL_MS`      | `60000`                                        | Floor 1000. Set by no template                                                                                                                                                                             | Lease TTL                                                                 |
| `KAGENTI_SANDBOX_HEARTBEAT_MS`      | `20000`                                        | Clamped to at most TTL/3. Set by no template                                                                                                                                                               | Lease renewal interval                                                    |
| `SH_SANDBOX_TIERS`                  | unset (untiered)                               | Comma-separated; duplicate or invalid names throw. **Must match the control plane exactly**                                                                                                                | Declared sandbox tiers                                                    |
| `SH_SANDBOX_DEFAULT_TIER`           | the only tier, if one                          | **Required** when more than one tier is declared; must be a declared tier                                                                                                                                  | Tier for sessions that do not choose                                      |
| `SH_SANDBOX_AFFINITY_TTL_SECONDS`   | `86400`                                        | Keep at least the P4 worker's `SH_WORKSPACE_IDLE`; **must equal the relay's copy**                                                                                                                         | How long a session remembers its sandbox                                  |
| `SH_SANDBOX_AFFINITY_GRACE_SECONDS` | `60`                                           | `0` is legal                                                                                                                                                                                               | How long a turn waits (503) for its sandbox before moving within the tier |

## Worker: turns, model and budget

| Variable                                                            | Default                                                        | Required / notes                                                                                                                                                     | Meaning                                                                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SH_TURN_DETACH`                                                    | off (only `1` enables)                                         | Templates enable it                                                                                                                                                  | Detachable, re-attachable turns                                                                       |
| `SH_TURN_DETACHED_MAX_S`                                            | `1800`                                                         | Blank or invalid falls back                                                                                                                                          | Unwatched turns end after this                                                                        |
| `SH_TURN_LOG_TTL_S`                                                 | `86400`                                                        | Blank or invalid falls back                                                                                                                                          | A finished turn stays replayable this long                                                            |
| `SH_TURN_STREAM_TOOL_RESULT_PREVIEW_BYTES`                          | `2048`                                                         |                                                                                                                                                                      | Byte cap on `tool_result` previews in the stream                                                      |
| `SH_TURN_STREAM_KEEPALIVE_MS`                                       | `20000`                                                        | `0` disables                                                                                                                                                         | Interval of the stream's `: keepalive` comment                                                        |
| `SH_TURN_STREAM_FIRST_FRAME_FLUSH_MS`                               | `15000`                                                        | `0` disables                                                                                                                                                         | Flush SSE headers if no frame by then                                                                 |
| `SH_MODEL_PROVIDER`                                                 | `anthropic` (`openai` on the custom `openai-completions` path) |                                                                                                                                                                      | Model provider                                                                                        |
| `SH_MODEL`                                                          | `claude-opus-4-8`                                              | A blank value is kept as an empty string. `/turn` sessions always use it; only a leaf's envelope or leaf config can override it (a config bundle has no model field) | Model id                                                                                              |
| `SH_MODEL_CUSTOM`                                                   | off (only `1` enables)                                         | Requires a base URL (below)                                                                                                                                          | Synthesize a model not in Pi's registry                                                               |
| `SH_MODEL_API`                                                      | `anthropic`                                                    | `anthropic`, `anthropic-messages` or `openai-completions`. `openai-responses` throws "not yet implemented"; any other value throws "Unknown SH_MODEL_API"            | API family of the custom model                                                                        |
| `SH_MODEL_BASE_URL`                                                 | none                                                           | A custom model throws without it, unless `ANTHROPIC_BASE_URL` (anthropic) or `OPENAI_BASE_URL` (openai) is set                                                       | Endpoint                                                                                              |
| `SH_MODEL_AUTH`                                                     | `bearer`                                                       | `openai-completions` only (ignored with `anthropic`). `custom-header` and `none` strip the Authorization header                                                      | Auth style                                                                                            |
| `SH_MODEL_HEADERS`                                                  | none                                                           | `openai-completions` only (ignored with `anthropic`). JSON object; `${VAR}` in values is interpolated from env. May carry secrets                                    | Extra request headers                                                                                 |
| `SH_MODEL_CONTEXT_WINDOW`                                           | `131072`                                                       |                                                                                                                                                                      | Custom model context window                                                                           |
| `SH_MODEL_MAX_TOKENS`                                               | `8192`                                                         |                                                                                                                                                                      | Custom model max tokens                                                                               |
| `SH_BUDGET_TOKENS`, `SH_BUDGET_MARGIN`                              | none                                                           | Applied only when a positive number                                                                                                                                  | Token budget and margin                                                                               |
| `ANTHROPIC_API_KEY`                                                 | none                                                           | **Secret.** Under `multi` tenancy it is forced to a sentinel and every ambient provider credential is scrubbed (see below)                                           | Provider key                                                                                          |
| `ANTHROPIC_AUTH_TOKEN`                                              | none                                                           | **Secret.** Not used for an authenticated (control-plane) turn                                                                                                       | Gateway bearer                                                                                        |
| `ANTHROPIC_BASE_URL`                                                | none                                                           |                                                                                                                                                                      | Gateway or endpoint                                                                                   |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`                                 | none                                                           | **Secret** (key). `OPENAI_API_KEY` is seeded with `unused` for `custom-header` and `none`                                                                            | OpenAI-compatible provider                                                                            |
| `HARNESS_CWD`                                                       | process cwd                                                    |                                                                                                                                                                      | Turn working directory                                                                                |
| `LEAF_RESULT_TTL_SECONDS`                                           | `86400`                                                        | A blank value parses to NaN (not the default)                                                                                                                        | TTL of sync `/runs` leaf results                                                                      |
| `SH_RUN_HEARTBEAT_MS`                                               | `10000`                                                        | Blank or invalid falls back                                                                                                                                          | How often a sync `/runs` run refreshes its in-flight heartbeat (#558)                                 |
| `SH_RUN_STALE_MS`                                                   | `60000`                                                        | Blank or invalid falls back; clamped to at least 2× `SH_RUN_HEARTBEAT_MS` (a stale window shorter than the heartbeat would read every live run as dead)              | A silent run holder reads as dead after this; the reaper then finalizes its run `failed`/`owner_lost` |
| `SH_RUN_REAP_INTERVAL_MS`                                           | `30000`                                                        | Non-positive falls back to the default                                                                                                                               | Sweep interval of the orphaned-run reaper every worker arms (#558)                                    |
| `KAGENTI_SYNC_SATURATION_WAIT_MS`, `_BACKOFF_MS`, `_MAX_BACKOFF_MS` | `30000`, `250`, `5000`                                         | Parsed leniently                                                                                                                                                     | Sync `/runs` retry while the pool is saturated                                                        |
| `KAGENTI_SYNC_SATURATION_RETRY_AFTER_S`                             | `5`                                                            |                                                                                                                                                                      | Retry-After seconds, also used for `/turn`                                                            |

Pi finds provider credentials by variable shape (`*_API_KEY`, `*_AUTH_TOKEN`, `*_OAUTH_TOKEN`,
`HF_TOKEN`, `COPILOT_GITHUB_TOKEN`, and the Bedrock AWS and Vertex ADC sources;
`packages/knative-server/src/server-process.ts`). Under `MOCA_TENANCY=multi`, `scrubAmbientCredentials`
deletes all of them from the worker's environment, not only `ANTHROPIC_API_KEY`.

For authenticated turns, inference credentials come from the control plane per user rather than from
these variables; see [the migration guide](../migrating-from-knative.md#configuration-what-changes).

## Worker: Context Service workloads (optional)

Enabled only when `MOCA_CONTEXT_WORKLOADS_ENABLED=1` and `CONTEXT_SERVICE_URL` is set; otherwise
`/workloads` returns 501. See [`docs/context-service.md`](../context-service.md).

| Variable                                                    | Default                    | Notes                                                                                                           |
| ----------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `MOCA_CONTEXT_WORKLOADS_ENABLED`                            | off                        | Feature switch                                                                                                  |
| `CONTEXT_SERVICE_URL`                                       | none                       |                                                                                                                 |
| `CONTEXT_SERVICE_PUBLIC_URL`                                | none                       | Required for workloads; HTTPS except on loopback                                                                |
| `CONTEXT_SERVICE_TOKEN`                                     | none                       | **Secret.** Required for workloads                                                                              |
| `CONTEXT_SERVICE_NAMESPACE` (falls back to `POD_NAMESPACE`) | `default`                  |                                                                                                                 |
| `CONTEXT_SERVICE_TIMEOUT_MS`                                | `5000`                     |                                                                                                                 |
| `MOCA_CONTEXT_MAX_STORAGE_GIB`                              | `10`                       |                                                                                                                 |
| `MOCA_CONTEXT_MAX_WORKLOADS_PER_OWNER`                      | `5`                        |                                                                                                                 |
| `MOCA_WORKLOAD_DELETED_TTL_SECONDS`                         | `86400`                    | TTL of the deleted-workload record                                                                              |
| `MOCA_CONTEXT_ROLLBACK_RETRY_ATTEMPTS`                      | `3`                        | Create-rollback cleanup attempts (including the first) while Context Service is unreachable; `1` means no retry |
| `MOCA_CONTEXT_ROLLBACK_RETRY_BACKOFF_MS`                    | `500`                      | Backoff between those attempts                                                                                  |
| `MOCA_CONTEXT_STORAGE_CLASSES`                              | empty (any class rejected) |                                                                                                                 |

These settings are checked per request, not at boot: a missing `CONTEXT_SERVICE_TOKEN` or URL returns
500 `workloads_misconfigured`.

Workloads with sandboxes of their own (phase 2, [`docs/context-service.md`](../context-service.md),
"Own sandboxes"), off unless `MOCA_PROVISIONER_URL` is set:

| Variable                          | Default     | Notes                                                                        |
| --------------------------------- | ----------- | ---------------------------------------------------------------------------- |
| `MOCA_PROVISIONER_URL`            | unset (off) | moca-provisioner's internal API. Set, `POST /workloads` accepts `sandboxes`  |
| `MOCA_PROVISIONER_TOKEN`          | none        | **Secret.** Required with the URL (`500 workloads_misconfigured` otherwise)  |
| `MOCA_PROVISIONER_TIMEOUT_MS`     | `15000`     | Per-request timeout                                                          |
| `MOCA_PROVISIONER_DELETE_WAIT_MS` | `60000`     | How long `DELETE` waits for the workload's pods to go before answering `202` |
| `MOCA_WORKLOAD_MAX_SANDBOXES`     | `2`         | Largest `sandboxes.count`; the provisioner checks it again                   |

## moca-provisioner (`packages/provisioner`)

The only MOCA component with Kubernetes permissions in the sandbox namespace
([ADR-0043](../adrs/0043-workload-sandboxes-provisioner.md)). Secrets are files under
`CREDENTIALS_DIRECTORY`, or env vars of the same name.

| Variable                       | Default        | Notes                                                                                                                |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `MOCA_ATTACH_PRIVATE_KEY`      | none           | **Secret, required.** Ed25519 key that signs attach tokens; its public half is the relay's `MOCA_ATTACH_PUBLIC_KEYS` |
| `MOCA_PROVISIONER_TOKEN`       | none           | **Secret, required.** The workers' service token                                                                     |
| `SH_SESSION_TOKEN_PUBLIC_KEYS` | none           | Required. Verifies the API token a worker forwards                                                                   |
| `MOCA_SANDBOX_NAMESPACE`       | `moca-sandbox` | The one namespace it acts in                                                                                         |
| `MOCA_PROVISIONER_PORT`        | `8080`         |                                                                                                                      |
| `MOCA_WORKLOAD_MAX_SANDBOXES`  | `2`            | `count` per workload                                                                                                 |
| `MOCA_OWNER_MAX_SANDBOXES`     | `4`            | An owner's replicas across all workloads                                                                             |
| `MOCA_ATTACH_TOKEN_TTL_S`      | `86400`        | Attach-token lifetime; re-minted when less than half remains                                                         |
| `MOCA_PROVISIONER_RECONCILE_S` | `300`          | How often it checks tokens for re-minting                                                                            |

The pod template is the PodTemplate `moca-workload-sandbox` in the sandbox namespace
(`deploy/k8s/base/workload-sandboxes/template.yaml`: the shared pool's image, resources, relay address
and security settings, with no Secret); the provisioner adds the attach token as a file. It runs as
exactly one replica (`replicas: 1`, `Recreate`): the per-owner cap is serialized in the process, so a
second replica could let two concurrent requests both pass it.

## Sandbox relay

`packages/sandbox-relay/src/main.ts`.

| Variable                          | Default                                                                                                  | Required / notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Meaning                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `SH_RELAY_PORT`                   | `8443`                                                                                                   | Templates use `9443`. Sandboxes dial it as `RELAY_ADDR`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Attach bind port (all interfaces)                                      |
| `MOCA_RELAY_EXEC_ADDR`            | unset (exec shares the attach listener)                                                                  | Templates set a separate listener. The supervisor's `SH_RELAY_ADDR` must dial this                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Bind address for `SandboxExec`                                         |
| `MOCA_RELAY_EXEC_TOKEN`           | none                                                                                                     | **Secret, required.** The relay refuses to boot without it, or if it equals `SH_RELAY_TOKEN` or a per-sandbox env token                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Exec caller credential; must equal the supervisor's                    |
| `SH_RELAY_TOKEN`                  | none                                                                                                     | **Secret.** Attach is fail-closed: with no token every attach is rejected. An empty value counts as missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Shared sandbox attach token; must match each sandbox's `SANDBOX_TOKEN` |
| `SH_RELAY_TOKEN_<sandboxId>`      | falls back to `SH_RELAY_TOKEN`                                                                           | **Secret.** Looked up verbatim by sandbox id, so an id with a dash cannot have an env token where the environment cannot carry a dashed name (systemd drops them, so not on the VM or a microVM host). It is never looked up in `SH_RELAY_TOKEN_DIR` and uses `SH_RELAY_TOKEN` there. `setup-microvm.sh` rejects dashed ids and writes these                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Per-sandbox attach token                                               |
| `SH_RELAY_TOKEN_DIR`              | unset                                                                                                    | One file per sandbox id (ids must match `^[A-Za-z_][A-Za-z0-9_]*$`; `DIR` is reserved), read on each attach. An unreadable or empty file refuses the attach; a file equal to the exec token is refused at attach time, not at boot. K8s mounts `/run/relay-tokens`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Token directory                                                        |
| `MOCA_ATTACH_PUBLIC_KEYS`         | unset (no workload labels: every `Hello` label is mirrored as sent, and an Exec's `workload` is ignored) | `<kid>:<base64 Ed25519 SPKI>[,...]`, the format of `SH_SESSION_TOKEN_PUBLIC_KEYS`. A malformed entry refuses the boot. Set, a sandbox may attach with a `moca-attach+jwt` token instead of its relay token. The token needs `iss=moca-provisioner`, `aud=moca-relay-attach`, a known `kid` and an unexpired `exp` (30 s leeway); the id must be `<wl>-<ordinal>` (`^<wl>-(0\|[1-9][0-9]*)$`) with the ordinal below the token's `n`. The relay closes the attach stream when the token's `exp` passes, and stamps `moca.dev/workload`, `moca.dev/owner` and `moca.dev/tier` from it; every other `Hello` loses its `moca.dev/workload` and `moca.dev/owner` labels and cannot take a `w-<32 hex>-<n>` id, and an Exec whose `workload` does not match its sandbox's is refused `PERMISSION_DENIED` ([workload sandboxes spec §3](../specs/2026-10-16-workload-sandboxes-design.md)) | Attach-token public keys (public halves only: the relay cannot mint)   |
| `SH_SANDBOX_AFFINITY_TTL_SECONDS` | `86400`                                                                                                  | **Must match the supervisor's**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | TTL of the detach mark                                                 |
| `REDIS_URL`                       | `redis://127.0.0.1:6379`                                                                                 | Same Redis as the supervisor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Sandbox pool mirror                                                    |

## Control plane

`packages/control-plane/src/main.ts`.

| Variable                                                                                                                                                 | Default                   | Required / notes                                                                                                 | Meaning                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SH_SESSION_TOKEN_PRIVATE_KEY`                                                                                                                           | none                      | **Secret, required**                                                                                             | Token signing key                                       |
| `SH_CREDENTIAL_KEK`                                                                                                                                      | none                      | **Secret, required**; must decode as a valid key ring                                                            | Envelope-encryption key ring for stored credentials     |
| `SH_EXCHANGE_TOKEN`                                                                                                                                      | none                      | **Secret, required.** Same value as the workers'                                                                 | Bearer workers present for the exchange hop             |
| `SH_GITHUB_CLIENT_ID`                                                                                                                                    | none                      | **Required.** A GitHub OAuth app with device flow enabled; no client secret                                      | Login                                                   |
| `SH_PUBLIC_HARNESS_URL`                                                                                                                                  | unset                     | Code does not require it (discovery returns `harnessUrl: null`), but the VM installer does. Absolute http(s) URL | Harness URL advertised to clients (`GET /v1/discovery`) |
| `SH_CONTROL_PLANE_PORT`                                                                                                                                  | `8080`                    | VM template uses `8090` (8080 is the supervisor's). Invalid silently falls back                                  | Listen port                                             |
| `SH_CONTROL_PLANE_HOST`                                                                                                                                  | all interfaces            | VM template sets `127.0.0.1`: plain HTTP, reach it through a tunnel                                              | Bind address                                            |
| `REDIS_URL`                                                                                                                                              | `redis://127.0.0.1:6379`  | Retries forever                                                                                                  | Ownership index, refresh tokens, bundles                |
| `SH_CREDENTIAL_STORE`                                                                                                                                    | `kubernetes`              | `kubernetes`, `file` or `vault`. VM and Compose use `file`                                                       | Credential store backend                                |
| `SH_CREDENTIAL_DIR`                                                                                                                                      | none                      | Required for `file`                                                                                              | File store path                                         |
| `SH_CREDENTIAL_NAMESPACE`                                                                                                                                | `sh-credentials`          | Kubernetes store; the K8s manifests use `moca-credentials`                                                       | Secret namespace                                        |
| `VAULT_ADDR`, `VAULT_TOKEN` or `VAULT_TOKEN_FILE` (exactly one), `VAULT_NAMESPACE`, `SH_VAULT_KV_MOUNT` (`secret`), `SH_VAULT_PATH` (`moca/credentials`) | none                      | Vault store only; no template wires it. Token is a **secret**                                                    | Vault credential store                                  |
| `SH_ADMIN_SUBJECTS`                                                                                                                                      | none                      | Comma-separated `github:<id>`                                                                                    | Admin role                                              |
| `SH_DEFAULT_INFERENCE_ENDPOINT`                                                                                                                          | none                      | Validated if set. For Anthropic use `https://api.anthropic.com` (no `/v1`)                                       | Gateway origin for credentials with no endpoint         |
| `SH_ALLOW_OPERATOR_FALLBACK`                                                                                                                             | off (only `true` enables) | `true` requires the token and endpoint, mutually consistent, or boot fails                                       | Users without their own credential spend the operator's |
| `SH_OPERATOR_INFERENCE_TOKEN`                                                                                                                            | none                      | **Secret.** On a VM, a credential file via a drop-in `setup-vm.sh` creates; never an env line                    | The operator's inference key                            |
| `SH_OPERATOR_INFERENCE_HEADER`                                                                                                                           | `authorization`           | `authorization` or `x-api-key`; an Anthropic API key needs `x-api-key`                                           | Header the operator key travels in                      |
| `SH_API_TOKEN_TTL_SECONDS` / `SH_SESSION_TOKEN_TTL_SECONDS`                                                                                              | `900` / `300`             | Invalid silently falls back                                                                                      | Token lifetimes                                         |
| `SH_REFRESH_IDLE_TTL_SECONDS` / `SH_REFRESH_MAX_TTL_SECONDS`                                                                                             | `2592000` / `7776000`     | Idle must not exceed max                                                                                         | Refresh token lifetimes                                 |
| `SH_REFRESH_REUSE_GRACE_SECONDS`                                                                                                                         | `30`                      | Invalid or `0` silently becomes 30, so the grace cannot be disabled; above 300 throws                            | Grace for a retried refresh                             |
| `SH_SANDBOX_TIERS` / `SH_SANDBOX_DEFAULT_TIER`                                                                                                           | as for the worker         | Must match the supervisor's exactly                                                                              | Tiers a session may choose                              |
| `SH_BUNDLE_SUBJECT_BYTES` / `SH_BUNDLE_TOTAL_BYTES`                                                                                                      | 16 MiB / 64 MiB           | Positive integer strings or boot fails                                                                           | Config-bundle byte budgets                              |
| `SH_SESSION_TOKEN_PUBLIC_KEYS`                                                                                                                           | empty                     | Malformed throws                                                                                                 | Extra public keys for rotation                          |
| `SH_INJECTOR_CONFIGURED`                                                                                                                                 | off                       | No template sets it                                                                                              | Skips the direct-mode mismatch check                    |
| `SH_SANDBOX_NAMESPACE`                                                                                                                                   | `default`                 | Used on Kubernetes paths                                                                                         | Sandbox namespace                                       |
| `SH_MODEL_CATALOG_HOSTS`                                                                                                                                 | empty                     | Comma-separated bare hostnames, case-insensitive; a URL, port or path refuses to boot                            | Extra hosts the model catalog may contact               |

**Outbound calls.** Besides the credential store and Redis, the control plane calls inference credential endpoints
when models are listed or chosen (`GET /v1/models`, `GET /v1/sessions/{id}/models`, `POST /v1/sessions` with a
`model`, `PATCH /v1/sessions/{id}`), with the endpoint's own scheme: `<endpoint>/v1/models` when the endpoint's host is
`api.anthropic.com`, `<endpoint>/model/info` for any other host. The endpoint's query and fragment are dropped.

The endpoint is the user's to choose, so these calls go only to an allow-listed host: `api.anthropic.com`, the host of
`SH_DEFAULT_INFERENCE_ENDPOINT`, and the hosts in `SH_MODEL_CATALOG_HOSTS`. Without the allow-list, any user with a
credential could make the control plane probe its own network (Redis, the identity provider, the Kubernetes API).
Private addresses are not refused as such, because an in-cluster gateway is usually on one. Add each gateway host your
users' credentials name, other than the default endpoint's, to `SH_MODEL_CATALOG_HOSTS` (for example
`litellm.team-a.svc,gw.example.com`). A host outside the allow-list is not contacted: listing returns
`model_catalog_unavailable` and a chosen model is accepted unverified, exactly as when the endpoint is down, and the
control plane logs the host with `not in the catalog allow-list (SH_MODEL_CATALOG_HOSTS)`.

Egress policies must allow these calls. Every failure gives the caller the same message, `the inference endpoint could
not list its models`; the log names the host and the reason (its status, no answer, not JSON, too large), never the
path, the query or the secret.

## Sandbox workers (Go)

### Container sandbox (`remote-worker/cmd/worker`)

| Variable                         | Default            | Notes                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_ADDR`                     | `localhost:8443`   | The relay's attach address                                                                                                                                                                                                                                                                                                |
| `SANDBOX_TOKEN`                  | `dev-token`        | **Secret.** Equals the relay's `SH_RELAY_TOKEN` (or its per-sandbox token). Do not leave the default                                                                                                                                                                                                                      |
| `SANDBOX_TOKEN_FILE`             | unset              | A file holding the token; when set it replaces `SANDBOX_TOKEN`, and is re-read on every dial and reconnect, so a rotated mounted Secret (a workload's attach token) is picked up. When the file changes, the worker reconnects with it at its next idle moment (no command running). Unreadable or empty at boot is fatal |
| `RELAY_TLS`, `RELAY_CA_FILE`     | off                | TLS to the relay; a garbage `RELAY_TLS` is fatal                                                                                                                                                                                                                                                                          |
| `SANDBOX_ID`                     | `sbx-laptop-1`     | Unique per sandbox                                                                                                                                                                                                                                                                                                        |
| `SANDBOX_TIER`                   | `container`        | Advertised as the `moca.dev/tier` label. If set but blank, no label: a tiered harness excludes the worker                                                                                                                                                                                                                 |
| `WORKER_MAX_CONCURRENT`          | `4`                | Concurrency slots; garbage or non-positive falls back                                                                                                                                                                                                                                                                     |
| `SANDBOX_IMAGE`, `SANDBOX_TRUST` | empty, `untrusted` | Labels                                                                                                                                                                                                                                                                                                                    |
| `SH_WORKSPACE_ROOT`              | built-in default   | Absolute path                                                                                                                                                                                                                                                                                                             |
| `SH_WORKSPACE_IDLE`              | built-in default   | Go duration; idle time after which a session workspace is deleted                                                                                                                                                                                                                                                         |

Commands run in a sandbox do not inherit the worker's own settings. The exact names `SANDBOX_TOKEN`,
`RELAY_ADDR`, `RELAY_TLS`, `RELAY_CA_FILE`, `SANDBOX_ID`, `SANDBOX_IMAGE`, `SANDBOX_TRUST` and
`WORKER_MAX_CONCURRENT`, and anything prefixed `SANDBOX_TOKEN_`, `SH_` or `MOCA_`, are stripped. Other
names (for example `SANDBOX_TIER`) do reach commands.

### MicroVM worker (`remote-worker/cmd/microvm-worker`)

It reads the same `RELAY_*` and `SANDBOX_*` variables (defaults `SANDBOX_ID=sbx-microvm-1`,
`SANDBOX_TIER=microvm`), plus:

| Variable                                                | Default           | Notes                                                                                                          |
| ------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `SH_SNAPSHOT_DIR`                                       | none              | **Required**                                                                                                   |
| `WORKER_MAX_CONCURRENT`                                 | `16`              | Positive integer; a malformed or non-positive value is **fatal**, not a fallback. Not the container worker's 4 | Concurrency slots; size `SH_MAX_COMMITTED_MB` against it |
| `SH_WORKSPACE_ROOT`                                     | none              | **Required**                                                                                                   |
| `SH_MAX_COMMITTED_MB`                                   | none              | **Required**, positive integer: the worker refuses to start without it. Size it against the slot count         | Committed-memory (OOM) gate                              |
| `SH_VMM`                                                | `firecracker`     | `fake` and unknown values are refused                                                                          |
| `SH_ALLOW_INSTANCE_TYPE_MISMATCH`                       | off               | Opts a host out of the snapshot instance-type check, for deliberate cross-host use                             | Skip the hardware-match check                            |
| `SH_STANDBY_DEPTH`                                      | built-in          | Warm standby VMs                                                                                               |
| `SH_GUEST_RAM_MB`                                       | built-in          | Per-guest RAM                                                                                                  |
| `SH_MAX_RUNS`                                           | `64`              | Positive integer                                                                                               |
| `SH_MEMORY_RESERVE_MB`                                  | none              | Positive integer if set                                                                                        |
| `SH_WORKSPACE_IDLE`                                     | built-in          | Go duration; `setup-microvm.sh` sets it from `MICROVM_WORKSPACE_IDLE` (default `8h`)                           |
| `SH_PARENT_CGROUP`                                      | built-in          | Slice-relative; under systemd a nonexistent path is fatal                                                      |
| `SH_JAILER_BIN`, `SH_FIRECRACKER_BIN`, `SH_CHROOT_BASE` | PATH, `/srv/jail` | Binary and jail locations                                                                                      |
| `SH_WORKSPACE_IMAGE_MB`                                 | `2048`            | Positive integer                                                                                               |
| `SH_SNAPSHOT_IMAGE`                                     | `default`         |                                                                                                                |

`SH_VIRTIOFSD_UID` and `SH_VIRTIOFSD_GID` (default `65534`) are read only in the Cloud Hypervisor arm, so
they do nothing with the default `SH_VMM=firecracker`.

Diagnostic switches (`SH_DIAG_PPROF`, `SH_DIAG_STATS_ADDR`, `SH_DIAG_PHASES`) and the Cloud
Hypervisor variables (`SH_CHV_*`, `SH_CH_REMOTE_BIN`, `SH_VIRTIOFSD_BIN`) exist but are not part of
the supported setup.

## mocactl

| Variable               | Default                      | Notes                                                   |
| ---------------------- | ---------------------------- | ------------------------------------------------------- |
| `SH_CONTROL_PLANE_URL` | saved config                 | Precedence: flag, env, config                           |
| `SH_HARNESS_URL`       | saved config, else discovery | Overrides the harness URL that discovery returns        |
| `XDG_CONFIG_HOME`      | `~/.config`                  | `mocactl/config.json` and the login file (holds tokens) |
| `XDG_STATE_HOME`       | `~/.local/state`             | Transcripts and exports                                 |
| `VISUAL` / `EDITOR`    | `vi`                         | External editor                                         |
| `NO_COLOR`             | off                          | Disables colour when non-empty                          |

`MOCACTL_VERSION`, `MOCACTL_INSTALL_DIR` and `MOCACTL_BASE_URL` (the releases URL, https only) are read
by the installer (`scripts/install-mocactl.sh`), not by `mocactl` itself.

## Installer-time variables

Read by the install scripts (`setup-vm.sh`, `setup-microvm.sh`, `deploy/compose/install.sh`,
`deploy/k8s/setup.sh`) rather than by the runtime. `SH_GITHUB_CLIENT_ID` and `SH_PUBLIC_HARNESS_URL`
are also read by the control plane, and `SANDBOX_IMAGE` by both Go workers (rows above). Each script's
header is authoritative.

- **Paths and image:** `SH_UNIT_DIR`, `SH_ENV_DIR`, `SH_INSTALL_DIR`, `SH_CRED_DIR`, `SH_REPO_ROOT`,
  `SH_SANDBOX_COUNT`, `SH_SANDBOX_RELAY_ADDR`, `SH_BIN_DIR`.
- **VM sandbox network:** `MOCA_SANDBOX_SUBNET`, `MOCA_SANDBOX_GATEWAY`, `MOCA_SANDBOX_BRIDGE`.
- **MicroVM installer:** `MICROVM_SANDBOX_ID`, `MICROVM_WORKSPACE_IDLE`, `MICROVM_SNAPSHOT_DIR`,
  `MICROVM_BIN`, `MICROVM_ATTACH_TIMEOUT`, `MICROVM_ATTACH_SETTLE`, `MICROVM_MAX_COMMITTED_MB`.
- **Compose `install.sh` inputs:** `SH_COMPOSE_DIR`, `SH_COMPOSE_BASE_URL`, `SH_HARNESS_IMAGE`.
- **Compose file interpolation (`docker-compose.yml`):** `SH_SANDBOX_IMAGE`, `SH_PORT`, `SH_CP_PORT`,
  `MOCA_RELAY_EXEC_PORT`, `MOCA_RELAY_BRAIN_IP`, `MOCA_BRAIN_SUBNET`, `COMPOSE_PROFILES`.
- **Kubernetes `setup.sh`:** `SH_P4_SANDBOX_IDS`, `SH_SANDBOX_EGRESS_EXCEPT`, `SH_ROUTE_DOMAIN`,
  `SH_SINGLE_NAMESPACE`, `SH_WAIT_SECONDS`, `SH_PUBLIC_HARNESS_URL` (port-forward-reached targets
  only: overrides the default `http://127.0.0.1:8080`).

## Legacy: Knative-only variables

Read only by code that runs on the deprecated Knative/KEDA path. No P6 template sets them. (Other
`KAGENTI_*` and `LEAF_*` variables above are live on P6 because the P6 worker serves the same
handler.)

| Variable                                      | Notes                                                |
| --------------------------------------------- | ---------------------------------------------------- |
| `K_SERVICE`, `K_CONFIGURATION`, `K_REVISION`  | Guard for the deprecation warning (`deprecation.ts`) |
| `SH_SERVICE_URL`, `JOB_NAME`, `CRON_CONFIG`   | The CronJob on-ramp (`cron-dispatch`)                |
| `KAGENTI_SANDBOX_POD`, `KAGENTI_SANDBOX_NAME` | Single-pod `kubectl exec` sandbox                    |
| `KAGENTI_EXEC_TIMING`                         | Exec timing logs of the `kubectl` transport          |

## Known inconsistencies

- `SH_PUBLIC_HARNESS_URL` is documented as required in the VM env template, but only the installer
  enforces it.
- `SH_PERSISTENT_EXEC` and `ANTHROPIC_MODEL` appear in the supervisor `/metrics` allowlist but are
  read by no P6 code; `SH_WORKER_ID` is set for each forked worker and no reader was found.
- `SH_ROUTING_POLICY=stickyBySession` is valid but appears in no template.
