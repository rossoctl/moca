# M5 Design: Compaction-Checkpoint Fast Path + Budget Voter

Version: 1.0 — June 23, 2026
Status: Design (approved for implementation planning)
Scope: Make cold-start session reconstruction O(tail) instead of O(total entries) by riding
Pi's native compaction as the checkpoint, and cap runaway token spend with a budget voter.

Parent plan: [MOCA (Pi Track) Implementation Plan](../../../docs/research/2026-06-10-moca-pi-track-plan.md) — **Milestone M4, Tasks 13–14** ("Compaction-checkpoint fast path").
Predecessor: [M4 Design — Knative Serverless Wrapper](2026-06-17-m4-knative-serverless-wrapper-design.md)

> **Milestone numbering.** The repo numbers milestones sequentially and offset from the
> pi-track plan (the repo's `m4-knative` doc itself notes it implements the plan's "M3",
> because the repo inserted an extra `m3-persistent` milestone). Following that convention,
> this is **repo milestone 5**, and it implements the **pi-track plan's Milestone M4**
> (Tasks 13–14). The plan's literal Task 13/14 code does **not** apply verbatim — it targets
> an API (`FileSessionBackend`, `append({position,session_id,type,data})`, `CtxMsg`,
> `reconstruct.ts`) that does not exist in this repo. This spec re-targets the milestone to
> the real architecture.

---

## 1. Goal & scope

M1–M4 built: Redis-backed session storage (M1), remote sandbox execution (M2), a persistent
in-pod channel (M3), and a Knative scale-to-zero HTTP wrapper (M4). On cold start, the harness
reconstructs a session by full-replaying the Redis log: `SessionManager.openFromBackend()`
(`pi-fork/.../session-manager.ts:1422`) calls `backend.read(sessionId)` with **no**
`fromPosition`, pulling every entry and indexing all of them.

M5 delivers the **compaction-checkpoint fast path** and a **budget voter**:

1. A checkpoint-aware loader (`SessionManager.openFromCheckpoint`) that reads only the
   latest-compaction-forward slice of the log, making cold-start local reconstruction
   **O(tail)** rather than O(total entries).
2. A budget voter that meters per-turn token spend and blocks tool calls once a cap is
   breached, recording an `abort` entry — the enforcement primitive the parent plan's E5
   experiment exercises.

M5 is **done** when:

1. A session that has compacted at least once resumes via `openFromCheckpoint`, reading only
   the kept-tail-forward slice, and its reconstructed `buildSessionContext()` is **identical**
   to a full `openFromBackend` reconstruction (parity test, real Redis) — with one documented
   caveat: `thinkingLevel` resets to the settings default (`"off"`) on the first post-compaction
   resume because Pi's session-start `thinking_level_change` entry is pre-`firstKeptEntryId`
   and thus excluded from the tail; this self-heals on the next turn. `model` is unaffected
   (re-set by every assistant message, always inside the kept tail). Safe while thinking level
   is settings-governed and not changed per session.
2. A session that has never compacted falls back to full reconstruction (no regression).
3. The budget voter blocks a tool call and appends an `abort` entry once per-turn spend
   exceeds the configured cap, and is inert when unconfigured.
4. Pi still builds and its own tests pass after the additive `openFromCheckpoint` method; all
   existing harness/session-backend/k8s-sandbox suites stay green.

### Honest reframing (right-sizes the milestone)

The parent plan's premise was: "without a checkpoint, cold start replays _all_ turns to the
LLM, so latency grows with session length." Discovery (file:line evidence in §2) shows this is
**already false for Pi** — Pi compaction is a first-class log entry, and `buildSessionContext()`
(`session-manager.ts:330–432`) already assembles only `[compaction summary, …kept tail,
…post-compaction]`, never the full history. So the LLM context is already bounded by
compaction.

What remains O(total entries) on cold start is purely **local** reconstruction: the Redis read,
the `_buildIndex()` pass, and the leaf→root walk in `buildSessionContext()`. The loader's
measurable win is bounding _those_ to O(tail) — reduced Redis bandwidth and CPU at large
session lengths — **not** a reduction in LLM latency, which dominates wall-clock and is already
bounded. This spec builds the loader as the parent plan's "O(1) reconstruction" deliverable
while setting honest expectations: the parent plan's E2 experiment should measure **local
reconstruction cost**, not end-to-end latency, to see the effect cleanly.

### In scope

- `RedisSessionBackend`: deterministic stream ids so `read(fromPosition)` is O(tail); a
  `positionOfId` helper.
- Checkpoint-marker extension: on `session_compact`, append a tiny `custom` "checkpoint" entry
  recording the resume position.
- `SessionManager.openFromCheckpoint()`: additive pi-fork method; the fast-start loader.
- Budget voter extension: pure `decideBudget` + a `tool_call` hook that blocks and logs `abort`.
- Wiring both extensions and the loader into `harness/src/run-turn.ts`.
- Unit + integration tests, including the reconstruction parity gate.

### Out of scope

- **`everyK` / idle-forced checkpoint cadence.** We ride Pi's native compaction cadence. A
  forced trigger (to bound cold-start for long-but-uncompacted sessions) is deferred; add it
  only if the E2 experiment shows it is needed.
- **Cumulative cross-turn / cross-cold-start budget.** The voter meters spend within the
  current turn/process. A persisted lifetime ledger is deferred (YAGNI for the PoC + E5).
- **A separate context snapshot.** Context lives in Pi's `compaction` entry; the marker holds
  only a pointer.
- **The E1–E5 experiments themselves** (parent plan M5/M6) — separate milestone.

---

## 2. Discovery findings (the design rests on these)

All references are in `pi-fork/packages/coding-agent/src/`.

| #   | Finding                                                                                                                                                                                                                                                            | Evidence                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Pi persists compaction as a first-class log entry carrying the summary, `firstKeptEntryId`, and `tokensBefore`.                                                                                                                                                    | `SessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?)` — `session-manager.ts:1009`; `CompactionEntry` — `session-manager.ts:70`. |
| F2  | `buildSessionContext()` reconstructs only `[summary, …kept tail, …post-compaction]` — never the full history.                                                                                                                                                      | `session-manager.ts:401–424`.                                                                                                                                             |
| F3  | The leaf→root walk **stops gracefully when a parent is not in the loaded set** (`byId.get(parentId)` → `undefined` ends the loop). This is what makes tail-only loading safe.                                                                                      | `session-manager.ts:357–363`.                                                                                                                                             |
| F4  | The kept messages sit in the log **before** the compaction entry, emitted from `firstKeptEntryId`. ⇒ the resume slice must start at `firstKeptEntryId`, not at the compaction entry's position.                                                                    | `session-manager.ts:406–418`.                                                                                                                                             |
| F5  | `SessionStorageBackend` already has `read(sid, fromPosition?)` and `latestCheckpoint()`; `latestCheckpoint` is **declared but never called by Pi core**, so we own its semantics.                                                                                  | `core/session-storage-backend.ts:14–22`; no other call site.                                                                                                              |
| F6  | `openFromBackend` is the only public loader and reads **all** entries (`backend.read(sessionId)`, no `fromPosition`). `loadFromEntries`/`_buildIndex` are private. ⇒ a fork-free harness-side tail loader is not possible; the loader belongs in `SessionManager`. | `session-manager.ts:1422–1434`, `:829–834`.                                                                                                                               |
| F7  | `tool_call` can block (`{ block: true, reason }`) and mutate `event.input`.                                                                                                                                                                                        | `ToolCallEventResult` — `core/types.ts:1020`; emit — `agent-session.ts:403–423`; block — `runner.ts:875`.                                                                 |
| F8  | Live token usage is available to handlers via `ctx.getContextUsage()` / `getSessionStats()`. `getContextUsage().tokens` is **`null`** between a compaction and the next LLM response.                                                                              | `agent-session.ts:2923` (`getSessionStats`), `:2968` (`getContextUsage`); `ContextUsage` — `types.ts:281`.                                                                |
| F9  | `read(fromPosition)` today reads the whole stream then filters by position (O(N)); entries are appended with auto stream id `"*"`.                                                                                                                                 | `packages/session-backend/src/redis-backend.ts:41–54`, `:31`.                                                                                                             |

---

## 3. Key decisions

| #   | Decision                                  | Choice                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | What is "the checkpoint"?                 | **Pi's native `compaction` entry.** No separate context snapshot. Reconstruction reuses Pi's battle-tested `buildSessionContext()`, so cold == warm context by construction.                                                                                                                                                                                               |
| D2  | How does cold start find where to resume? | A **resume-pointer marker**: on `session_compact`, append a tiny `custom`/`checkpoint` entry recording `resumeFromPosition` = the log position of the compaction's `firstKeptEntryId` (F4). Metadata only. This gives the existing `latestCheckpoint()` (F5) something to return.                                                                                          |
| D3  | Where does the loader live?               | A new **additive** `SessionManager.openFromCheckpoint()` in pi-fork (F6). `openFromBackend` is left untouched for other callers. Falls back to `openFromBackend` when there is no marker.                                                                                                                                                                                  |
| D4  | Efficient tail read                       | `RedisSessionBackend` assigns each entry the stream id `"<position>-0"` (positions are already monotonic 1-based via `INCR`), so `read(fromPosition)` becomes `XRANGE key <fromPosition>-0 +` = O(tail). Backward-compatible for fresh sessions.                                                                                                                           |
| D5  | Cadence                                   | **Ride Pi's compaction cadence.** No `everyK` policy (out of scope).                                                                                                                                                                                                                                                                                                       |
| D6  | Budget metric                             | **Per-turn token-spend delta**: `getSessionStats().tokens.total − baseline` (baseline captured at turn start, so loaded-tail usage is excluded). We deliberately meter cumulative _spend_, **not** `getContextUsage()` context-window fill — the latter resets at compaction and is `null` right after (F8). A missing/`null` stat reading ⇒ **do not block** (defensive). |
| D7  | Budget cap source                         | Env `SH_BUDGET_TOKENS` (unset ⇒ voter disabled / inert). Optional `SH_BUDGET_MARGIN` for headroom.                                                                                                                                                                                                                                                                         |
| D8  | Log entries written by the voter          | Only an **`abort`** custom entry on block. **No** per-tool-call `vote` entry (the stale plan wrote one; that is log bloat — E5 only checks for `abort`).                                                                                                                                                                                                                   |
| D9  | Extension placement                       | Extensions live in **`harness/src/`** beside the existing `flush-extension.ts` — matching the real codebase. **No** new `packages/checkpoint` / `packages/budget-voter` (the stale plan's layout predates seeing that extensions live in the harness). Pure logic stays in small testable modules.                                                                         |

---

## 4. Architecture

```
┌──────────────────────────── cold start (resume) ───────────────────────────┐
│ harness/src/run-turn.ts                                                     │
│   SessionManager.openFromCheckpoint(sid, backend, cwd)   ◄── NEW (pi-fork)  │
│     marker = backend.latestCheckpoint(sid)        // custom "checkpoint"     │
│     if !marker → openFromBackend(sid,…)            // never compacted → full │
│     slice  = backend.read(sid, marker.resumeFromPosition)  // [firstKept..]  │
│     loadFromEntries(sid, slice)  → buildSessionContext()  == warm context    │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────── during a turn ─────────────────────────────────┐
│ extensions registered on the Pi session (DefaultResourceLoader):            │
│   flushExtension            (existing)  turn_end / shutdown → backend.flush()│
│   k8sSandboxExtension        (existing)                                      │
│   checkpointMarkerExtension  NEW  on session_compact:                        │
│        pos = store.positionOfId(sid, compactionEntry.firstKeptEntryId)       │
│        append custom {customType:"checkpoint", resumeFromPosition: pos}      │
│   budgetVoterExtension       NEW  on session_start: baseline = stats.total   │
│                                   on tool_call: decideBudget(...)            │
│                                       block + append "abort" if over cap     │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.1 File layout

```
moca/
  pi-fork/packages/coding-agent/src/core/
    session-manager.ts            # edit — add static openFromCheckpoint()
  packages/session-backend/src/
    redis-backend.ts              # edit — stream id "<position>-0"; positionOfId()
  packages/session-backend/test/
    redis-backend.test.ts         # edit — tail-read + positionOfId tests
  harness/src/
    checkpoint-extension.ts       # NEW — session_compact → resume-pointer marker
    budget-voter.ts               # NEW — decideBudget (pure) + tool_call extension
    run-turn.ts                   # edit — use openFromCheckpoint; register extensions
  harness/test/
    budget-voter.test.ts          # NEW — decideBudget unit tests
    checkpoint.test.ts            # NEW — marker write + reconstruction parity (real Redis)
```

### 4.2 `RedisSessionBackend` changes (`packages/session-backend`)

- **append**: replace `xAdd(key, "*", …)` with `xAdd(key, \`${position}-0\`, …)`. The position
  is already computed before the add. Entries remain readable identically.
- **read(fromPosition)**: `xRange(key, \`${fromPosition}-0\`, "+")`and drop the post-filter.
(Keep a defensive position filter only if mixing old`"*"`-id sessions — but those are
  pre-M5 throwaway dev sessions; D4 scopes this to fresh sessions.)
- **positionOfId(sid, id)**: read entries (O(N), acceptable — see §7) and return the `position`
  of the stored entry whose decoded `entry.id === id`, or `null`.

### 4.3 `SessionManager.openFromCheckpoint()` (pi-fork, additive)

```ts
// signature mirrors openFromBackend (session-manager.ts:1422)
static async openFromCheckpoint(
  sessionId: string,
  backend: SessionStorageBackend,
  cwd: string = process.cwd(),
): Promise<SessionManager> {
  const marker = await backend.latestCheckpoint(sessionId);          // F5
  const resumeFrom = markerResumePosition(marker);                   // null if absent/invalid
  if (resumeFrom == null) {
    return SessionManager.openFromBackend(sessionId, backend, cwd);  // fallback, full
  }
  const entries = await backend.read(sessionId, resumeFrom);         // F4: [firstKept..leaf]
  if (entries.length === 0) {
    return SessionManager.openFromBackend(sessionId, backend, cwd);  // defensive fallback
  }
  const sm = new SessionManager(cwd, "", undefined, false, undefined, backend);
  sm.loadFromEntries(sessionId, entries);   // reuse private path (session-manager.ts:829)
  return sm;
}
```

`markerResumePosition` reads `resumeFromPosition` from the marker's payload. The
checkpoint marker is a Pi `CustomEntry` (`type:"custom"`, `customType:"checkpoint"`,
`data:{resumeFromPosition:number}`).

### 4.4 Checkpoint-marker extension (`harness/src/checkpoint-extension.ts`)

```ts
export function checkpointExtension(store: LogStore, sm: SessionManager): ExtensionFactory {
  return (pi) => {
    pi.on('session_compact', async (e) => {
      // e.compactionEntry (F1)
      const sid = sm.getSessionId();
      const pos = await store.positionOfId(sid, e.compactionEntry.firstKeptEntryId); // F4
      if (pos != null) {
        sm.appendCustomEntry('checkpoint', { resumeFromPosition: pos }); // rides flush
      }
    });
  };
}
```

The marker is written through Pi's own `appendCustomEntry` (`session-manager.ts:1032`) so it
flows through the existing buffered backend and flush path. Writing through the session manager
(not directly to the store) keeps positions consistent with Pi's append ordering.

### 4.5 Budget voter (`harness/src/budget-voter.ts`)

```ts
export interface BudgetState {
  spent: number;
  estimated: number;
  limit: number;
}
export type BudgetDecision =
  { decision: 'commit' } | { decision: 'abort'; reason: 'budget_exceeded' };

export function decideBudget(s: BudgetState): BudgetDecision {
  if (!Number.isFinite(s.limit) || s.limit <= 0) return { decision: 'commit' }; // disabled
  return s.spent + s.estimated > s.limit
    ? { decision: 'abort', reason: 'budget_exceeded' }
    : { decision: 'commit' };
}

export function budgetVoterExtension(
  sm: SessionManager,
  opts: {
    limit: number;
    margin?: number;
  },
): ExtensionFactory {
  return (pi) => {
    let baseline: number | null = null;
    pi.on('session_start', (_e, ctx) => {
      baseline = sessionStatsTotal(ctx);
    });
    pi.on('tool_call', (_e, ctx) => {
      const total = sessionStatsTotal(ctx); // cumulative spend (D6); NOT getContextUsage (F8)
      if (baseline == null || total == null) return {}; // null ⇒ don't block (D6)
      const spent = total - baseline;
      const d = decideBudget({ spent, estimated: opts.margin ?? 0, limit: opts.limit });
      if (d.decision === 'abort') {
        sm.appendCustomEntry('abort', { reason: d.reason, spent, limit: opts.limit }); // D8
        return { block: true, reason: 'Session token budget exceeded' }; // F7
      }
      return {};
    });
  };
}
```

`sessionStatsTotal(ctx)` returns the session's cumulative input+output token total. **Implementer must confirm** how this is exposed to a `tool_call` handler's context: discovery found `getSessionStats()` on the agent session (`agent-session.ts:2923`) and `getContextUsage()` on the extension ctx (`types.ts:328`). If the ctx exposes `getSessionStats`, use it; otherwise thread the session/agent reference into the factory. Use the cumulative **spend** total (number), not `getContextUsage().tokens` (nullable, context-window fill). `limit` comes from `Number(process.env.SH_BUDGET_TOKENS)` in `run-turn.ts`; unset/0 ⇒ inert.

### 4.6 Wiring (`harness/src/run-turn.ts`)

- Resume path (`:45–47`): `sessionId ? await SessionManager.openFromCheckpoint(sessionId, backend, cwd) : SessionManager.create(...)`.
- `extensionFactories` (`:56`): append `checkpointExtension(store, sessionManager)` and, when
  `SH_BUDGET_TOKENS` is set, `budgetVoterExtension(sessionManager, { limit, margin })`.

---

## 5. Verification gate

### Unit

- `decideBudget`: commits below cap; aborts when `spent + estimated > limit`; commits when limit ≤ 0 (disabled).
- `RedisSessionBackend`: `read(fromPosition)` returns exactly the tail (positions ≥ fromPosition) using stream-id seek; `positionOfId` returns the right position and `null` for an unknown id.

### Integration (real Redis on localhost:6379)

- **Reconstruction parity (the gate):** drive a session that compacts at least once (append a real `compaction` entry + a `checkpoint` marker), then assert
  `buildSessionContext()` from `openFromCheckpoint` deep-equals the result from `openFromBackend`.
- **Resume recalls kept context:** after a compaction, a fresh `openFromCheckpoint` includes the compaction summary and every kept-tail message; the slice read is strictly smaller than the full log.
- **Never-compacted fallback:** with no marker, `openFromCheckpoint` reconstructs identically to `openFromBackend`.
- **Budget voter:** with a low `SH_BUDGET_TOKENS`, a synthetic over-baseline `getSessionStats` causes the `tool_call` handler to return `{ block:true }` and append exactly one `abort` entry; with the cap unset, no block and no `abort` entry.

### Build/regression

- `pnpm -C pi-fork/packages/coding-agent build` and its test suite pass after `openFromCheckpoint` (analyze logs via subagent per the context-budget rule).
- Existing harness, session-backend, k8s-sandbox suites stay green.

---

## 6. Deviations from the stale plan (Tasks 13–14)

| Plan (Task 13/14)                                                          | This spec                                                     | Why                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/checkpoint` + `packages/budget-voter`                            | Extensions in `harness/src/`                                  | Matches the real codebase (`flush-extension.ts` lives here).                                 |
| `shouldCheckpoint` + `everyK` cadence                                      | Ride Pi's compaction cadence                                  | Pi compaction already is the checkpoint; `everyK` is out of scope (deferred to E2 need).     |
| `writeCheckpoint(context)` snapshotting context                            | Tiny resume-pointer marker                                    | Context lives in Pi's `compaction` entry; don't duplicate it.                                |
| `decideBudget({cumulative, estimated, limit})` over an external cumulative | `decideBudget({spent, estimated, limit})` over per-turn delta | The serverless model is per-turn; cross-turn cumulative needs a persisted ledger (deferred). |
| `vote` entry per allowed tool call                                         | Only `abort` on block                                         | Avoids log bloat; E5 only inspects `abort`.                                                  |
| `FileSessionBackend`, `CtxMsg`, `reconstruct.ts`                           | — (do not exist)                                              | Re-targeted to the real `LogStore`/`SessionStorageBackend` + Pi's `buildSessionContext`.     |

---

## 7. Residual risks

| Risk                                                                                                                                                                                                              | Impact                                                | Mitigation                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `positionOfId` scans the whole stream (O(N)).                                                                                                                                                                     | Cost at marker-write time.                            | Runs only at `session_compact` (rare, already LLM-costly). Acceptable; revisit if compaction frequency rises.                                                                                                      |
| Stream-id scheme change (`"*"` → `"<position>-0"`) is incompatible with sessions written by older code.                                                                                                           | Old dev sessions may misread.                         | Scoped to fresh sessions (D4); pre-M5 sessions are throwaway. Document in README.                                                                                                                                  |
| `getSessionStats` delta is a "recent spend" proxy, not exact per-turn spend (loaded-tail messages carry prior usage; baseline subtraction mitigates but compaction within a turn can perturb it).                 | Voter trips slightly early/late.                      | Acceptable for PoC + E5 (single expensive task). `null`-handling prevents false blocks. Documented.                                                                                                                |
| The loader's benefit is local (I/O + walk), not LLM latency — see §1.                                                                                                                                             | E2 measured the wrong thing → "no effect".            | Spec states E2 must measure **local reconstruction cost**; flagged for the experiments milestone.                                                                                                                  |
| Tail-load loses access to pre-compaction entries by id (branches/labels).                                                                                                                                         | Non-issue for serverless resume (continues the leaf). | `openFromBackend` remains available for any full-history use; loader is opt-in.                                                                                                                                    |
| `openFromCheckpoint` tail-load excludes the session-start `thinking_level_change` entry (pre-`firstKeptEntryId`), so `buildSessionContext().thinkingLevel` resets to `"off"` on the first post-compaction resume. | `thinkingLevel` is wrong for one turn.                | Self-heals on next turn (Pi re-appends the entry). Safe while thinking level is settings-governed. `model` is unaffected (re-set by every assistant message, always in the kept tail). Locked by a dedicated test. |

---

## 8. Relationship to the parent plan

This implements the pi-track plan's **Milestone M4 — Compaction-checkpoint fast path**
(Tasks 13–14), re-targeted to the architecture the repo actually grew (M1–M4 in repo numbering).
It unblocks the parent plan's experiments milestone: **E2** (cold-start latency vs checkpoint)
and **E5** (budget voter enforcement) depend on the loader and the voter respectively. Per §1,
E2 should be framed around local reconstruction cost, since Pi's native compaction already
bounds LLM-facing context.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
