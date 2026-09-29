# ADR-0031: Promoted memory travels read-only; discoveries return in the leaf result

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-09-02
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-09-02-claude-code-workflow-promotion-design.md`](../specs/2026-09-02-claude-code-workflow-promotion-design.md) §5

## Context

Promoting a Claude Code workflow ([ADR-0030](0030-claude-code-workflow-promotion.md)) brings the
author's local memory with it — one-fact-per-file markdown plus a `MEMORY.md` index that Claude
Code loads each session. Carrying it _in_ is straightforward. Whether a promoted run may write
memory _out_ is a separate and harder question, and it is the kind that gets asked later ("why
can't the managed runs learn?"), so it is recorded on its own.

Three forces bear on it. The harness is filesystem-free
([ADR-0020](0020-fs-free-harness.md)): "the agent saves a memory file" has nowhere to land
without a new persistence path, so writes are a deliberate choice rather than a default. The leaf
contract is idempotent: `harness/src/run-leaf.ts:67` treats `session_id` as the idempotency key
and maps a retry or resume of the same envelope deterministically onto the same session. And a
local memory directory is user- and machine-scoped, holding operational notes that in practice
discuss credentials and private infrastructure.

Building a dedicated memory service was considered as the general answer, and would be a
plausible home for it — `packages/session-backend` already abstracts the durable store.

## Decision

We will ship memory **read-only**. It travels in the bundle and is injected as context; a
promoted session never writes it. What a run _learns_ returns as data in the leaf result
(`harness/src/leaf-result-store.ts`), and a human decides whether any of it becomes a durable
memory locally.

Memory gets progressive disclosure rather than bulk injection: only `MEMORY.md` is injected
inline as the index, while the memory files themselves are overlaid **into the sandbox** at a
known path, because `read` executes in the sandbox and cannot see the harness pod's `/tmp`. That
reproduces local recall semantics at the cost of one index in context.

"Where memory comes from" is a **resolver interface with exactly one implementation** (the bundle
snapshot). Pi's `agentsFilesOverride` makes memory just another context source, so substituting a
memory service later is a constructor argument rather than a redesign. We are not building that
service now.

### Alternatives considered

- **Read-write, synced back to the laptop** — closes the learning loop, but mutable shared memory makes a leaf's behavior depend on what other leaves learned first, so replaying an envelope no longer reproduces the run; in a large fan-out, memory becomes a race. It also writes into the author's future context with no review step.
- **Session-scoped writes (durable only within one run)** — redundant: within-run continuity is exactly what compaction checkpoints already provide ([ADR-0007](0007-compaction-checkpoint-fast-path.md)), and a second mechanism for it is drift.
- **A dedicated memory service now** — the right eventual answer to a _different_ problem (curated, team-shared knowledge across many runs, with ownership and staleness semantics). Speculative against this need, and it would land scope in the promotion path for a loop that a result field closes for free.
- **Ship no memory at all, flattening relevant facts into the prompt** — avoids sending personal context to a shared cluster, but discards the recall mechanism that made the local workflow work. Addressed instead by a user deny-list plus a blocking secret scan.

## Consequences

- Positive: leaf replay stays reproducible, so ADR-0030's promotion path inherits the existing idempotency contract unchanged rather than qualifying it. No new persistence path is added to a filesystem-free component. The learning loop still closes — through the leaf result, where a human reviews before anything becomes durable — and it costs no new infrastructure. Memory scales past any inline cap because the index is injected and the files are read on demand, matching local semantics.
- Negative / accepted cost: a promoted run cannot accumulate knowledge across dispatches; every run starts from what the author taught it locally. Operational discoveries require a human in the loop to become durable, which is friction by design but is still friction. Memory files reaching the sandbox means they land on a shared pool's volume, so the user deny-list and the secret scan (`packages/config-bundle/src/secret-scan.ts`) are what stand between private context and a shared cluster before promotion: five structural rules (AWS/GitHub/OpenAI/Slack token and private-key-block shapes) block it outright, while two prose heuristics (bearer tokens, `key: value`-shaped assignments) only warn — measured against a real `~/.claude` the heuristics were false-positive-dominated, so only the structural tier is load-bearing. The overlay's `chmod -R a-w` pass (`harness/src/config-overlay.ts`) separately enforces this ADR's read-only guarantee at the filesystem level, so a bundle that clears the scan still cannot be mutated once it reaches the sandbox. Write-protection is not lifetime, though, and the two were conflated at first: the digest-keyed cache initially had no teardown at all, so promoted memory stayed on the shared volume after its leaf ended and a later leaf carrying no `configRef` could read it — breaking spec §2 goal 6 observably, since tools run in the sandbox ([#216](https://github.com/rossoctl/moca/issues/216)). The cache is therefore refcounted: each leaf registers a file under `/workspace/.sh-config/.refs/<digest>/` and the release drops the tree once the last one goes, all under the same per-pod `flock` the populate path uses. Concurrent fan-out still transfers a bundle once (spec §4.5); reuse across separate dispatches is given up deliberately, so a dispatch arriving after the pool went idle re-transfers. Concurrent cross-leaf visibility remains an accepted non-goal (P2 §9; Kata isolation is P3/#48) — what is now guaranteed is that promoted memory does not survive the leaf that brought it. And the read-on-demand path depends on the sandbox overlay succeeding, so a memory read failure surfaces as a tool miss rather than a configuration error.
- Follow-up owed: revisit a memory service only when there is a real multi-run, multi-author knowledge-sharing need, at which point it implements the existing resolver interface. If a promoted workflow turns out to genuinely need durable self-authored state, that is a new ADR superseding this one, not an amendment.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
