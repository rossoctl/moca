# Observability

> **Preview.** For P6 on Kubernetes. Metrics are JSON, not Prometheus format; there is no exporter in the repository.

## Supervisor admin port

The supervisor serves a second listener on `SH_ADMIN_PORT` (8081). It is unauthenticated: loopback by default, and
bound to all interfaces in the Kubernetes manifest so the kubelet can probe it. The NetworkPolicy lets pods in the
`moca` namespace scrape it; anything outside needs its own policy.

| Route          | Answer                                                                                 |
| -------------- | -------------------------------------------------------------------------------------- |
| `GET /healthz` | 200 `ok`, always. It does not check workers                                            |
| `GET /readyz`  | JSON `{ready, workers, healthy}`; 200 if at least one worker is healthy, otherwise 503 |
| `GET /metrics` | JSON (below)                                                                           |

Saturation does **not** make `/readyz` fail. The 429 on the data port is the overload signal, so a busy pod is not
pulled from the Service.

`/metrics` contains:

- `workers[]`: `id`, `pid`, `inFlight`, `healthy`, `loop_lag_p99_ms`, `rss_bytes` (unmeasurable values appear as the
  string `"NaN"`);
- `counters`: `restarts`, `handoff_retries`, `handoff_failures`, `over_admission`, `spurious_refusals`,
  `head_truncations`;
- `lease_saturation` and `file_op_p95_ms` aggregates;
- `env`: the allowlisted settings `PORT`, `SH_WORKERS`, `SH_TURNS_PER_WORKER`, `SH_ROUTING_POLICY`,
  `SH_SANDBOX_DISCOVERY`, `SH_REMOTE_SANDBOX`, `SH_PERSISTENT_EXEC`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`.

## Probes in the manifests

| Workload      | Probes                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Supervisor    | Startup on `/readyz` (5 s x 30), readiness on `/readyz`, liveness on `/healthz`; all on the admin port |
| Control plane | Readiness `/readyz`, liveness `/healthz`                                                               |
| Relay         | TCP on the attach port only; it has no health endpoint                                                 |
| Redis         | `redis-cli ping`                                                                                       |
| Sandbox       | **None**                                                                                               |

The control plane's `/healthz` does not depend on Redis, so an outage does not restart it; its `/readyz` fails with
503 `redis_unavailable` when Redis is not ready or does not answer within 500 ms.

## Logs

- **Supervisor:** one JSON object per line on stdout. Events include `supervisor_listening`, `shutdown_step`
  (`drained`, `accepting_stopped`, `turns_finished`, `grace_expired`), `worker_ready`, `worker_exit`,
  `worker_channel_error`, `handoff_retry`, `handoff_failed`, `head_truncated`, `over_admission`.
- **Control plane:** plain prefixed lines, for example `[control-plane] redis client error: ...`,
  `[control-plane] audit write failed for <route> <target>: ... -- the write itself SUCCEEDED`.
- **Data plane and workers:** `[redis] <label>: <message> (node-redis will reconnect)`, and
  `[deprecation] ... is deprecated` for the old route aliases.
- **Relay:** plain text, for example `presence put failed for <id> (attempt N, retrying in X ms): ...`,
  `relay token for <id> unreadable`, `relay token for <id> equals the exec token; refused`,
  `sandbox-relay: SIGTERM, draining`.

Worth alerting on: `worker_exit` or a rising `restarts` counter, `grace_expired`, repeated `presence put failed`,
`redis client error`, `audit write failed`, non-zero `handoff_failures`, `over_admission` or `head_truncations`, and
the audit decision `refresh_reuse_detected`.

## The audit stream

The control plane appends to the Redis stream `sh:cp:audit` (trimmed to about 1,000,000 entries) with fields `ts`,
`subject`, `decision`, and optionally `sessionId`, `credential` (a name, never a value), `configRef`, `bytes`, `reason` and
`family` (written by every refresh-token decision). Decisions: `credential_issued`, `operator_fallback_used`, `session_created`, `session_deleted`,
`session_deleted_in_flight`, `credential_written`, `credential_deleted`, `config_bundle_uploaded`,
`config_bundle_unchanged`, `config_bundle_refused`, `config_bundle_deleted`, and the refresh-token decisions
`refresh_issued`, `refresh_rotated`, `refresh_refused`, `refresh_reuse_detected`, `refresh_revoked` (`reason`
`logout`, `logout_all`, or `not_enrolled`: a sandbox-profile refresh by a subject no longer in `SH_ALLOWED_SUBJECTS`,
whose family the control plane revokes so the client's last token is later refused as `revoked`, not as reuse). Anonymous
refusals go to `sh:cp:audit:anon` (about 100,000). Read them with `redis-cli XREVRANGE sh:cp:audit + - COUNT 50`
through `kubectl exec`; no HTTP endpoint for the audit stream is documented.

## Per-session placement

Workers report, best effort, where each session ran. `GET /v1/sessions/{id}/resources` returns the session, harness,
sandbox, lease and placement (sandbox id, tier, and `workspaceReset`, either `{at, from}` or null; the stream event
is called `workspace_reset`). A top-level `queue` is always null. The data is self-reported by the harness
and display-only. Some fields still carry Knative-era values (`mode` is `leaf-job` or `knative`), and the sandbox
`phase` probably reads `unknown` on this deployment because the control plane has no pod permissions (inferred from
the manifests, not run).
