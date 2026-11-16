# ADR-0044: Mirror audit decisions to component stdout as structured JSON, carrying subject and sessionId

- **Status:** Accepted (2026-10-21; implemented by #563) <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-10-20
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-10-20-audit-log-mirror-design.md`](../specs/2026-10-20-audit-log-mirror-design.md)

## Context

MOCA records lifecycle decisions in the Redis stream `sh:cp:audit` — `session_created`,
`credential_issued`, `bundle_promoted`, `sandbox_created`, `refresh_rotated`, and so on, keyed by
subject and sessionId. The stream has what incident response needs and is not surfaced to
`kubectl logs`: control-plane audit sites `XADD` without a stdout mirror, and the data plane's
run path has no audit helper at all. A full `mocactl spawn` dispatch cycle emits ~zero
per-request lines across the server pods.

#359 separately asks for subject and sessionId on every log line. The two concerns share one fix.

## Decision

Mirror every audit decision to component stdout as one JSON line, carrying subject and sessionId.

- **Control plane.** `auditBestEffort` emits the line before the Redis `XADD`, so it still appears
  when Redis is down. Call sites that bypass that helper (three in `handlers.ts`, one in
  `exchange.ts`, five Lua-XADD paths in `refresh-redis.ts`) get sibling emits.
- **Data plane.** The P6 run path (`handleRunLeafParsed`) emits `run_started` once before
  `runLeaf` and `run_finalized` once after; saturation retries don't re-emit. The deprecated
  Knative/KEDA drain (ADR-0041) stays silent — its envelope does not carry `subject` and the path
  is being removed.
- **Shape.** Flat JSON via `(line: Record<string, unknown>) => void`, matching the supervisor's
  existing `opts.log`.
- **Attribution.** Explicit parameters at every emit site; no AsyncLocalStorage.
- **Policy.** Identifiers only. Never prompts, responses, filenames, display names, credential
  values, or raw error strings. The field whitelist and the three enforcement tests
  (`no-tokens`, `no-user-content`, `field-whitelist`) are in the spec.

### Alternatives considered

- **AsyncLocalStorage request context** — greenfield in this repo; explicit params already carry
  subject and sessionId at every emit site.
- **OTel SDK (`@opentelemetry/*`) now** — larger scope than #359 asks for. The flat JSON shape is
  ingestible by OTel's Filelog receiver; a future ADR can commit to semconv additively.
- **pino / winston** — new runtime dependency for the same JSON-per-line shape.
- **Extract the supervisor's `opts.log` into a shared module now** — scope creep. A 6-line
  duplication is cheaper and the signature matches, so a future consolidation ADR is trivial.

## Consequences

- Positive: `kubectl logs | jq 'select(.event=="audit")'` is now a grep surface for session
  lifecycle, without cluster-admin Redis access. #359's attribution test is satisfied by
  construction. Future OTel adoption remains open.
- Negative / accepted cost: one small log line per audit decision, under the per-pod log budget.
  Pod stdout retention is governed by the kubelet rotation and whatever aggregator the operator
  runs — MOCA cannot retract an emitted line, and a `session_deleted` entry is appended, not
  applied retroactively. The identifiers-only rule is the compensating control: emitted lines
  are effectively permanent.
- Not covered: tool-call transcript retrieval (separate upstream request); the deprecated
  KEDA/Knative drain, silent per-request until it is removed; the sandbox pods and the
  context-service pod, out of scope for #359.
