# ADR-0004: Expose the harness as a scale-to-zero Knative HTTP service

- **Status:** Implemented
- **Date:** 2026-06-17
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-17-m4-knative-serverless-wrapper-design.md`](../specs/2026-06-17-m4-knative-serverless-wrapper-design.md)

## Context

M1–M3 externalized session state to Redis and tool execution to a remote pod, but the harness still runs headless via `cli.ts` — one prompt per process. To prove the parent plan's core thesis (idle-cost economics via scale-to-zero with acceptable interactive latency), the harness must become a service that wakes on demand and idles to zero.

## Decision

We will extract a reusable `runTurn()` from `cli.ts` and wrap it in a new `@moca/knative-server` package serving `POST /turn`, deployed as a Knative Serving service with `min-scale: 0` and `containerConcurrency: 1` so it scales 0→1→0 per request.

### Alternatives considered

- **Streaming / SSE responses** — deferred; M4 uses simple blocking request/response as the simplest proof of the serverless loop.
- **An HTTP framework (Express, etc.)** — rejected; Node's built-in `http` keeps the image small with zero added deps.
- **Multi-request concurrency per pod** — avoided via `containerConcurrency: 1`; Knative scales horizontally instead of sharing in-pod state.

## Consequences

- Positive: Cold-start turns work against a scaled-to-zero service; session state survives the scale gap via Redis alone; `runTurn()` is shared by CLI and server.
- Negative / accepted cost: Cold-start latency (Knative + Node + Redis + LLM) is measured but not optimized; `containerConcurrency: 1` caps throughput.
- Follow-up owed: Compaction-checkpoint fast path (M5) to keep cold starts fast at scale.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
