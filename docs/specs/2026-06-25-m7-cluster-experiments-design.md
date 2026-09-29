# M7 Design: End-to-End Cluster Experiments (E1 / E3-mobility / E4)

Version: 1.0 — June 25, 2026
Status: Design (for review)
Scope: Harden M4's deployed-harness smoke claims into three rigorous, measured end-to-end
**cluster** experiments on the Kind + Knative deploy — E1 (scale-to-zero economics),
E3-mobility (session reconstruction on a fresh instance), E4 (crash recovery) — driven by bash
extending `deploy/knative/smoke.sh`.

Parent plan: [MOCA (Pi Track) Implementation Plan](../../../docs/research/2026-06-10-moca-pi-track-plan.md) — experiments **E1 (Task 17)**, **E3 (Task 19)**, **E4 (Task 20)**.
Predecessors: [M4 — Knative Serverless Wrapper](2026-06-17-m4-knative-serverless-wrapper-design.md) (the deploy this builds on) and [M6 — Experiments E2 + E5](2026-06-24-m6-experiments-design.md) (§8.1 defined this sequel).

> **Milestone numbering.** Repo milestone **M7**. M6 (E2/E5) measured _local_ behavior in-process;
> M7 measures the _deployed serverless system_ end-to-end. The parent plan's literal drivers
> (Python, `requests`, ksvc `pi-harness` in `kagenti-system`) do **not** apply — re-targeted to
> bash + the real deploy (ksvc `moca` in namespace `default`).

---

## 1. Goal & scope

M4 deployed the harness as a Knative service and its `smoke.sh` proved, informally, that the pod
scales to zero (Claim 3) and that a cold start recalls session state from Redis (Claim 4). M7
turns those informal claims into **reproducible experiments with explicit metrics and pass
criteria**, plus the economics comparison the project's serverless thesis rests on.

M7 is **done** when, on the running Kind cluster, three idempotent bash drivers each print a clear
`PASS`/`FAIL` with their numbers, and the results are recorded in `deploy/knative/EXPERIMENTS.md`:

1. **E1 — economics:** serverless (`min-scale=0`) pod-seconds are materially below persistent
   (`min-scale=1`) over an idle-heavy workload.
2. **E3 — mobility:** after the session's pod is gone, a _fresh_ instance answers a follow-up that
   requires earlier-turn context, reconstructed from the Redis log.
3. **E4 — recovery:** force-killing the pod mid-session loses zero completed turns; the next turn
   continues from the persisted log.
4. `smoke.sh` still passes after its choreography is factored into a shared lib; pi-fork untouched.

### In scope

- A reusable bash lib (`deploy/knative/lib.sh`) factored out of `smoke.sh`.
- Three drivers `deploy/knative/e1-economics.sh`, `e3-mobility.sh`, `e4-recovery.sh`.
- A setup/harden step: correct target names, (re)create the `llm-credentials` secret from env, set
  `SH_MODEL=claude-haiku-4-5` on the ksvc.
- `deploy/knative/EXPERIMENTS.md` recording the runs.

### Out of scope

- Exact cloud billing model (pod-seconds is the cost proxy); production autoscaler tuning.
- Non-Knative platforms; multi-node scale.
- The `session_shutdown` dead-handler cleanup in `flush-extension.ts` (noted in §7; harmless).
- E2-fidelity / any in-process measurement (covered by M5 parity + M6/E2).

---

## 2. Discovery findings (the design rests on these)

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                    | Evidence                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| F1  | The harness extension lifecycle events M7 depends on **fire in the headless `runTurn` path**: `session_compact` (→ checkpoint marker) at `agent-session.ts:1733` (manual) / `:2013` (auto-compaction), and `turn_end` (→ flush) at `agent-loop.ts:218`; both via `_extensionRunner.emit`, no `bindExtensions` gate. ⇒ the checkpoint marker **is** written in production; the M5/M6 fast path is not dormant; E3-mobility's premise holds. | Subagent trace, 2026-06-25.                       |
| F2  | `session_shutdown` is **never** emitted in headless (only `reload()` / interactive `AgentSessionRuntime`), so `flush-extension.ts:15`'s handler is dead — but harmless, since `turn_end` fires each turn and `run-turn.ts` calls an explicit final `backend.flush()`.                                                                                                                                                                      | Same trace; `flush-extension.ts:14-15`.           |
| F3  | The deploy uses ksvc **`moca`** in namespace **`default`** (not the parent plan's `pi-harness`/`kagenti-system`). Annotations: `min-scale:0`, `max-scale:5`, `scale-to-zero-pod-retention-period:30s`, `target-burst-capacity:0`, `containerConcurrency:1`.                                                                                                                                                                                | `deploy/knative/service.yaml:4-16`.               |
| F4  | LLM creds already reach the ksvc via the `llm-credentials` secret (`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`). The ksvc does **not** set `SH_MODEL` (defaults to `claude-opus-4-8`). M4's smoke did real gateway turns.                                                                                                                                                                                          | `service.yaml:23-44`; `SMOKE.md`.                 |
| F5  | `smoke.sh` already implements the core choreography: POST `/turn` (create + resume), wait-for-scale-to-zero, cold-start resume assertion. E3/E4 are extensions of it.                                                                                                                                                                                                                                                                      | `deploy/knative/smoke.sh`, `SMOKE.md` Claims 2–5. |
| F6  | The Kind cluster `sh-knative` is running, so M7 can execute against the live deploy.                                                                                                                                                                                                                                                                                                                                                       | env.                                              |

---

## 3. Key decisions

| #   | Decision          | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Driver style      | **Bash, extending `smoke.sh`** (kubectl + curl + jq), under `deploy/knative/`. Cluster ops are native to kubectl/curl; `smoke.sh` already does ~80% of the choreography; no new toolchain.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D2  | E1 cost metric    | **Sampled pod-seconds**: poll `kubectl get pods -l serving.knative.dev/service=moca -n default` every `SAMPLE_INTERVAL` (default 5s); pod-seconds = Σ(running harness pods × interval). Run the same workload once at `min-scale=1`, once at `min-scale=0`.                                                                                                                                                                                                                                                                                                                                                                                            |
| D3  | E1 pass criterion | **serverless ≤ 0.6 × persistent** pod-seconds (≥40% reduction) over the idle-heavy pattern, AND report both absolute numbers + ratio. Magnitude depends on the idle/retention ratio (documented); the gate is directional + a clear margin.                                                                                                                                                                                                                                                                                                                                                                                                            |
| D4  | Scope             | **One milestone**, one branch, shared setup + `lib.sh` + one `EXPERIMENTS.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D5  | Experiment model  | Set **`SH_MODEL=claude-haiku-4-5`** (dash-form, anthropic) on the ksvc — cheap/fast for the many real turns. The M6 `requireModel` guard protects against a bad id. **Note:** non-anthropic models (e.g. Gemini) through the litellm gateway are **not** a config-only switch — the gateway bridge keeps the model's pi-ai `api`, and `gemini-2.0-flash` is registered under `google` with the native `google-generative-ai` transport (not litellm's anthropic `/v1/messages`). Routing Gemini would need a small wire-id bridge (anthropic transport + a gateway model alias); **deferred** to a possible future harness milestone, out of M7 scope. |
| D6  | Target names      | ksvc `moca`, namespace `default` (F3) — parameterized as `KSVC`/`NS` in `lib.sh`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D7  | Credentials       | (Re)create the `llm-credentials` secret from the operator's env at setup; **no secrets in the repo**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D8  | E3/E4 assertions  | **Conversational recall**, not tool-dependent: the model must echo an earlier-turn fact (a planted token). No sandbox tool needed, so model/tool availability is irrelevant to these gates.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

---

## 4. Architecture

```
deploy/knative/
  lib.sh            # NEW — shared helpers (sourced by smoke.sh + all drivers)
                    #   ns/ksvc vars; base_url; post_turn(sid,text)->json;
                    #   harness_pod_count(); wait_scale_to_zero(timeout);
                    #   set_min_scale(n); force_kill_pod(); require_secret()
  smoke.sh          # EDIT — source lib.sh; behavior unchanged (regression anchor)
  service.yaml      # EDIT — add SH_MODEL=claude-haiku-4-5 env on the ksvc
  e1-economics.sh   # NEW — sampled pod-seconds: min-scale=1 vs 0 over an idle pattern
  e3-mobility.sh    # NEW — multi-turn task; force fresh pod; follow-up recalls earlier context
  e4-recovery.sh    # NEW — kill pod mid-session; next turn loses no completed turns
  EXPERIMENTS.md    # NEW — recorded results (E1 numbers/ratio; E3/E4 PASS/FAIL)
  run-experiments.sh# NEW — setup/harden + run all three, write EXPERIMENTS.md
```

### 4.1 Setup/harden (`run-experiments.sh` preamble + `lib.sh`)

- Resolve `NS=default`, `KSVC=moca`; derive the Kourier base URL + Host header
  exactly as `smoke.sh` does today.
- `require_secret`: if `llm-credentials` is absent, create it from `ANTHROPIC_API_KEY` /
  `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` in the operator's env (fail clearly if unset).
- Apply `SH_MODEL=claude-haiku-4-5` to the ksvc (idempotent `kubectl patch`/apply).
- Smoke-check one real `/turn` before running experiments (fail fast if the deploy is unhealthy).

### 4.2 E1 — economics (`e1-economics.sh`)

- Workload: `E1_TURNS` (default 5) short `/turn` calls to one session, separated by
  `E1_IDLE` (default 120s) idle gaps (≫ the 30s retention, so serverless scales down between).
- For `MIN in 1 0`: `set_min_scale($MIN)`; start a background sampler (`harness_pod_count` every
  5s, accumulate pod-seconds); run the workload; stop the sampler; record pod-seconds.
- Emit: `persistent_pod_seconds`, `serverless_pod_seconds`, `ratio`. **PASS** when
  `serverless ≤ 0.6 × persistent`.

### 4.3 E3 — mobility (`e3-mobility.sh`)

- Create a session; turn 1 plants a fact (`"Remember the code word: ZEBRA42."`); a few more turns.
- Force a fresh instance: `set_min_scale(0)` + `wait_scale_to_zero` (assert the pod is gone), so the
  next request cold-starts a **new** pod.
- Follow-up turn: `"What is the code word?"`. **PASS** when the response contains `ZEBRA42`
  (instance B reconstructed context from the Redis log — not from in-pod memory).

### 4.4 E4 — recovery (`e4-recovery.sh`)

- Create a session; complete turns t1, t2, t3 (each returns 200; the log is flushed per `turn_end`).
- `force_kill_pod` (`kubectl delete pod -l … --force --grace-period=0`) mid-session.
- Next turn: `"List everything we've discussed so far."`. **PASS** when the response/log reflects
  t1–t3 (zero completed-turn loss) and the turn succeeds on the freshly-started pod.

### 4.5 Results (`EXPERIMENTS.md`)

`run-experiments.sh` appends a dated section: the E1 table (persistent/serverless pod-seconds +
ratio + verdict) and E3/E4 `PASS`/`FAIL` with the asserted token / turn evidence. Committed.

---

## 5. Verification gate

- **Live/manual** (needs the `sh-knative` cluster + gateway creds, like M6's live E5):
  `deploy/knative/run-experiments.sh` runs setup + all three drivers; each prints `PASS`/`FAIL`
  to a redirected log (analyze via subagent per the context-budget rule).
  - E1: serverless ≤ 0.6 × persistent pod-seconds; numbers recorded.
  - E3: follow-up on a fresh pod contains the planted token.
  - E4: post-kill turn reflects all completed turns.
- **Regression:** `smoke.sh` still passes after sourcing `lib.sh` (its 6 claims unchanged).
- pi-fork untouched; no new package/toolchain.

---

## 6. Deviations from the parent plan (Tasks 17, 19, 20)

| Plan                                                    | This spec                                               | Why                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Python drivers (`requests`, `subprocess`)               | Bash extending `smoke.sh`                               | Matches the existing deploy scripts; no Python toolchain in a TS repo.                                                                                 |
| ksvc `pi-harness` in `kagenti-system`                   | ksvc `moca` in `default`                                | The real deploy (F3).                                                                                                                                  |
| E1 "count pod startTimes"                               | Sampled pod-seconds (Σ running × interval)              | startTime count measures pod _count_, not idle _cost_; sampling integrates running time.                                                               |
| E3 `__dump_context__` equality of reconstructed context | Conversational recall of a planted token on a fresh pod | Fidelity (context equality) is already proven by M5 parity + M6/E2; M7's E3 is the _mobility_ half — does a new instance actually answer from the log. |
| E5 reprise on cluster                                   | —                                                       | E5 fully covered in-process by M6.                                                                                                                     |

---

## 7. Residual risks

| Risk                                                                                           | Impact                   | Mitigation                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cluster/gateway flakiness (cold-start latency, gateway rate limits/timeouts).                  | Spurious FAIL.           | Generous curl timeouts (ksvc `timeoutSeconds:300`); retry the setup smoke-check; drivers are re-runnable.                                                                              |
| E1 magnitude depends on the idle/retention ratio; with small idle gaps the difference shrinks. | Weak/ambiguous result.   | Defaults `E1_IDLE=120s` ≫ 30s retention; params tunable; report absolute numbers so the result is interpretable even if the 0.6 gate is borderline.                                    |
| Sampled pod-seconds is approximate (5s granularity; may miss sub-interval scale events).       | Small measurement error. | Acceptable for a cost _proxy_; interval tunable; both configs sampled identically so bias cancels in the ratio.                                                                        |
| `claude-haiku-4-5` may not reliably echo the planted token for E3/E4.                          | Recall assertion flaky.  | Prompts explicitly instruct verbatim recall; assertion greps a distinctive token (`ZEBRA42`); these are conversational (no tool needed, D8). Fall back to a stricter prompt if needed. |
| `scale-to-zero-pod-retention-period:30s` / `stable-window` tuning affects timing.              | Waits mis-timed.         | `wait_scale_to_zero` polls with a timeout (as `smoke.sh` does); thresholds derived from the ksvc annotations, not hard-coded guesses.                                                  |
| Refactoring `smoke.sh` into `lib.sh` could regress it.                                         | Breaks the M4 smoke.     | `smoke.sh` is the regression anchor — it must still pass post-refactor (§5).                                                                                                           |

---

## 8. Relationship to the parent plan

Implements the pi-track plan's **E1 (Task 17)**, **E3 (Task 19, mobility half)**, and **E4
(Task 20)**, re-targeted from Python/`pi-harness` to bash against the real `moca`
deploy. Together with M6 (E2 local cost, E5 budget) and M5 (E2/E3 fidelity via the parity gate),
this closes the parent plan's experiment set. E3's fidelity half and E5 are already done; M7 adds
the cluster-level economics, mobility, and recovery evidence.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
