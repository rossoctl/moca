# Harness Lock-Down Design — defend the brain by making local execution boring

Version: 1.0 — June 26, 2026
Status: Design (approved for implementation planning)
Scope: How the **harness** (the "brain" — Pi runtime + our wrapper, the component that builds
prompts, calls the LLM provider, and writes the durable Redis log) is contained, given that it
holds the only secret worth defending (the provider key) and that tool execution is _not_
guaranteed to be redirected to the sandbox. The thesis: the harness needs **no L7 egress proxy** —
it has no model-controlled egress surface — so it is defended by making any local execution in it
**unrewarding and unable to phone home**, not by mediating egress it never makes.
Milestone relationship: **Refines the harness portion of parent M7/M8.** It _lightens_ M7 (no
egress proxy for the harness) and sets up M8 (the provider-key injector, specified separately next).
Parent design: [Zero-Trust, Multi-Agent Extensions to the MOCA](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) — §2 spine, §2.2 load-bearing claims, §3.1 inference broker, §4.1 invariants.
Builds on / consumes: M2 ([`K8sSandboxClient`](2026-06-17-m2-k8s-sandbox-client-design.md)), M3 ([persistent channel](2026-06-17-m3-persistent-channel-design.md)), M4 ([Knative wrapper](2026-06-17-m4-knative-serverless-wrapper-design.md)).
Sibling: [M13 — Generalized Credentialed Egress](2026-06-19-m13-generalized-credentialed-egress-design.md) (the **sandbox**'s heavyweight egress plane). This design explicitly argues that apparatus does **not** extend to the harness.

> **Implementation status (issue #66, 2026-07-07).** The **egress invariant** this design enforces:
> _the harness may reach only the **LLM inference** endpoint and the **sandbox** control channel; all
> other outbound traffic — git, arbitrary web, MCP/tool calls — flows through the sandbox, the single
> controlled I/O surface._ Two Z2 controls now back it in the tree:
> **(1) Fail-closed redirection (Layer 1)** — implemented and verified on `main`: `kubectlExecInPod`
> and the persistent channel reject on any child error / abort / timeout with **no local branch**, and
> the tool ops propagate exec rejections directly. There is no local-exec fallback on a routing error.
> **(2) Default-deny egress NetworkPolicy (Layer 3)** — ships as `deploy/knative/harness-egress-policy.yaml`,
> wired into both the Kind base and the OCP overlay (see Layer 3 for the shipped v1 rules).
> The **injector pod (H4/M8) is not yet built**, so the v1 allowlist reflects today's topology —
> `{DNS, Redis, external LLM :443, K8s API server}` — where the harness still holds the provider key
> and resolves the LLM hostname itself. The external `:443` rule and the DNS rule are the **M8 seam**:
> once the injector lands they collapse to in-cluster peers pinned by ClusterIP and the DNS rule is
> **removed entirely** — eliminating both the internet route and the DNS-tunnel exfil channel.

> **Why this exists.** The credential plane was designed quickly across three docs (parent → M10 →
> M13) that kept pivoting, and the apparatus grew heavyweight. This spec re-examines the **harness**
> on its own terms and finds it needs far less than the parent implied: its egress is
> fixed-destination, so the forward-proxy/CA/placeholder-swap machinery built for the sandbox is
> unjustified here. The real harness risk is **local execution**, which the current build does not
> fully prevent. This design closes that, cheaply.

---

## 1. Goal & scope

### The driving finding

Verification of `K8sSandboxClient` (the `@moca/k8s-sandbox` extension) shows tool redirection is
**override-based and fail-open**, not deny-by-default:

- When the sandbox config resolves, the extension calls `pi.registerTool()` to **override** Pi's 7
  built-in tools (`read`/`write`/`edit`/`ls`/`find`/`bash`/`grep`) with pod-backed handlers. There
  is no per-operation local fallback — good.
- **But the gate is fail-open:** `extension.ts:47` is `if (!config) return;`. If the config does not
  resolve (env miss, startup ordering, a refactor), the extension silently declines to register and
  **Pi's native `LocalShell` / `LocalFileSystem` tools stand** — the harness then executes
  model-directed commands locally.
- **And it overrides a known list of 7 tools.** Pi contains local-execution paths that bypass the
  Operations seam — the build already had to special-case `grep` because _"Pi's grep always spawns a
  LOCAL rg"_ (see `grep-tool.ts`). A future Pi version adding a tool, a subagent-spawn path, or
  another "spawns local X" shortcut would not be overridden and would run in the harness.

So at the capability level the harness today is **"allow-list of redirected tools with a local
fallback,"** and the fallback is Pi running model commands in the brain's pod. That is the surface
this design closes.

### In scope

- A **threat model for the harness** (§2): its assets, its trust position, and exactly what model
  output can and cannot make it do.
- A **lock-down design** (§4) in five layers that make local execution in the harness _unrewarding_
  (nothing to steal) and _unable to exfiltrate_ (no route out), plus _fail-closed_ redirection so
  accidental local execution stops happening at all.
- The explicit **lightening result** (§5): the harness needs no forward proxy, no baked CA, no
  placeholder-swap.
- A **verification gate** (§7).

### Out of scope (later / separate)

- **The provider-key injector internals** — fixed-upstream header injection, per-session inference
  budget enforcement, and how the key reaches _it_ (static Secret vs. SPIRE-bound). Specified in the
  **next** sibling design (the M8 injector). This doc fixes only the injector's **placement** (a
  separate pod, §4 layer 3 rationale) and the harness-side contract (a non-secret base-URL).
- **The sandbox threat model and its egress plane** — M13. Deliberately deferred per the
  brainstorm's scoping ("harness now, sandbox after").
- **Subagents** (parent M11) and **MCP** (M10) — they compose on the same harness posture but add
  nothing here.
- Production TLS/RBAC specifics beyond the identity/least-privilege model stated here.

---

## 2. Threat model (the harness)

### 2.1 What the harness is

Trusted code operating on **untrusted data**. The data is (a) model output and (b) the durable
session log — which a prior compromised session could have poisoned. The harness is _not_ a place
model-authored code is _supposed_ to run; all tool execution is meant to redirect to the sandbox.

### 2.2 Assets

| Asset                      | Why it matters                                                                                             | Worst case                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider key**           | The crown jewel. The harness builds prompts **and** writes the durable, append-only, broadly-replayed log. | Serialized into the log once → compromised **forever**, readable by every future harness instance, voter, and audit tool; or echoed into the conversation. |
| **Redis write access**     | The log is the source of truth / the spine.                                                                | Poisoning future resumes of this and other sessions.                                                                                                       |
| **`pods/exec` capability** | The harness drives the sandbox via `kubectl exec`.                                                         | Exec into other pods if the SA is over-broad.                                                                                                              |
| **Network position**       | Can reach provider, Redis, sandbox.                                                                        | An exfil route if egress is open to the internet.                                                                                                          |

### 2.3 Adversary & influence path

The adversary is **model output** (adversarial or prompt-injected) and **poisoned log content**.
The harness is trusted code, so the adversary cannot directly run code in it — _unless_ a harness
code path executes model-directed work locally. The two such paths today are exactly the §1
finding: (a) the **fail-open gate**, and (b) **un-overridden Pi local-exec paths**.

### 2.4 The egress observation that lightens everything

The harness makes only **fixed-destination** egress: LLM provider (inference), Redis (log), sandbox
(`kubectl exec` / channel). **None is model-controlled.** The model changes prompt _content_, never
the harness's destination. The "model code curls an arbitrary host" surface — the entire
justification for M13's forward proxy + baked CA + allowlist + placeholder-swap — **does not exist
in the harness.** Therefore the harness must not be defended by mediating egress; it must be
defended by ensuring that _if_ local code ever runs in it, that code finds **nothing to steal** and
has **nowhere to send it**.

### 2.5 Trust boundaries

```
  ┌─────────────────────────── harness pod (untrusted DATA, trusted CODE) ───────────────────────┐
  │  Pi runtime + wrapper                                                                          │
  │   • builds prompts, parses model output, writes log                                            │
  │   • SHOULD redirect all tool exec → sandbox (fail-closed, §4 L1)                                │
  │   • holds NO provider key (§4 L2)                                                               │
  │   • distroless, read-only, dropped caps (§4 L4)                                                 │
  │                                                                                                 │
  │   egress is DEFAULT-DENY (§4 L3): allowed ONLY to ↓                                             │
  └───────┬───────────────────────────┬───────────────────────────────┬──────────────────────────┘
          │ in-cluster                 │ in-cluster                    │ in-cluster (localhost? NO — separate pod)
          ▼                            ▼                               ▼
     K8s API server             Redis (log)                    Injector pod (M8)
     (pods/exec on the          (the spine)                    • holds provider key
      sandbox pods only)                                       • adds Authorization, TLS to provider
                                                               • ONLY component with public egress
```

No arrow from the harness pod to the public internet. That absence is the property the lock-down
guarantees.

---

## 3. Key decisions

| #   | Decision                      | Choice                                                                                                                                                                                                                                                                    |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | Egress proxy for the harness? | **No.** The harness has no model-controlled egress; an L7 forward proxy / baked CA / placeholder-swap (M13) is unjustified here.                                                                                                                                          |
| H2  | Primary defense               | **Defang local execution, don't mediate egress.** Make local code unrewarding (no secret) and unable to phone home (no route), and stop it happening (fail-closed).                                                                                                       |
| H3  | Redirect gate posture         | **Fail-closed.** In the zero-trust deployment a sandbox is _required_; unresolved sandbox config hard-fails (refuse to register local tools, refuse to run a turn). Replaces the current fail-open `if (!config) return;`.                                                |
| H4  | Provider key location         | **Not in the harness container.** Key lives only in a separate **injector pod** (M8). Harness reaches the provider via a non-secret base URL pointed at the injector.                                                                                                     |
| H5  | Exfil boundary                | **Pod-level NetworkPolicy, default-deny egress.** Allow only `{API server, Redis, injector pod}`. Kernel/CNI-enforced; no public `:443`.                                                                                                                                  |
| H6  | Injector placement            | **Separate pod, not a same-pod sidecar.** NetworkPolicy selects pods, not containers; a same-pod sidecar with provider egress would re-grant the harness container that egress (shared netns). A separate pod makes "harness has no internet route" actually enforceable. |
| H7  | Image                         | **Distroless-node (or scratch+node).** No shell/coreutils → Pi's `LocalShell` and "spawn local rg" paths fail at `ENOENT`.                                                                                                                                                |
| H8  | Pod hardening                 | `runAsNonRoot`, `allowPrivilegeEscalation:false`, `capabilities.drop:[ALL]`, `readOnlyRootFilesystem:true` (+ emptyDir `/tmp`), `seccompProfile:RuntimeDefault`.                                                                                                          |
| H9  | RBAC                          | **Least-privilege SA.** Keep `pods/exec` (the harness needs it to drive the sandbox) but scope it to **sandbox pods only** (dedicated namespace + label selector); no `get secrets`, no exec elsewhere.                                                                   |
| H10 | Honesty about residue         | Distroless does **not** disable Node's own `fs`/`net`/`child_process`; the NetworkPolicy (H5), not the image, is the exfil control. Layers are complementary; none is sufficient alone.                                                                                   |

---

## 4. The lock-down (five layers, by leverage)

### Layer 1 — Fail-closed redirection _(core; highest leverage, near-free)_

In the zero-trust deployment, treat the sandbox as **required**:

- Replace the fail-open early return with a **hard fail**: if sandbox config does not resolve at
  startup, the harness logs a loud error and **does not register Pi's local tools** and **does not
  run a turn**.
- Add a **boot-time assertion** ("sandbox config present, channel reachable, or die") and a
  **turn-level guard** so no turn can execute against local Operations even if a registration slips.
- This converts "usually redirected" → "structurally cannot run model commands locally by
  accident," closing the §1 fail-open hole at its root.

This is a deployment-mode posture, not a Pi change: local tools remain the legitimate default for
non-sandboxed local runs; the _zero-trust harness deployment_ refuses them.

### Layer 2 — Secret-free harness container _(core)_

- The provider key is **never mounted** into the harness container (no env, no file). It lives only
  in the injector pod (M8).
- The harness reaches the provider through a **non-secret base URL** (e.g. `ANTHROPIC_BASE_URL` /
  the OpenAI-compatible base URL) pointed at the injector. That value is not a secret.
- **Mechanism:** Kubernetes scopes env and volume mounts per container; a Secret not mounted into the
  harness container is genuinely absent from its `/proc/self/environ`. Secret-free is achieved by
  _not mounting_, nothing more exotic.
- **Invariant (parent §4.1):** a red-team `grep` over harness env + reconstructed prompt + the Redis
  log finds no provider key. Local code that does run finds nothing worth taking.

### Layer 3 — Default-deny egress NetworkPolicy _(core; the exfil boundary)_

- Default-deny egress on the harness pod; **allow only**: K8s API server (for `pods/exec`), Redis,
  and the injector pod. **No `0.0.0.0/0:443`.** _(This is the **M8 end-state**; the shipped v1 below
  is a documented intermediate that still has an external hop because the injector is not yet built.)_
- This is the control that actually closes exfil: even Node `fs`/`net` code running locally in the
  harness (which distroless cannot stop, H10) has **nowhere to send data**.
- **H6 dependency:** because NetworkPolicy is per-pod and a pod shares one netns, the injector must
  be a **separate pod** (not a sidecar) for "harness has no internet route" to hold while the
  injector still reaches the provider.
- **Shipped (v1, issue #66):** `deploy/knative/harness-egress-policy.yaml` — a `policyTypes: [Egress]`
  policy (ingress deliberately untouched so the Knative activator can still route into the pod)
  selecting the harness pod by its Knative label `serving.knative.dev/service: moca`,
  with a three-rule allowlist:
  - **DNS** (`:53` UDP+TCP) — to resolve the external LLM hostname.
  - **Redis** (`podSelector app=redis`, `:6379`) — the durable log, scoped to the in-cluster pod.
  - **Outbound HTTPS** (`:443`/`:6443` to `0.0.0.0/0`) — the external LLM provider **and** the
    in-cluster K8s API server (`pods/exec` = the sandbox control channel; `:6443` covers apiserver
    endpoints reached by DNAT from the `:443` `kubernetes.default` ClusterIP).

  Pre-M8 the LLM is external, so `0.0.0.0/0:443` and DNS are unavoidable and are explicitly the **M8
  seam**: the injector terminates the external hop, the harness then targets it by pinned ClusterIP so
  `:443` narrows to an in-cluster peer, and the DNS rule is **dropped**. Dropping DNS is part of the
  boundary, not incidental — DNS is itself an exfil channel (a compromised harness could tunnel data
  as `<data>.attacker.com` queries through the cluster resolver), so the end-state removes it so that
  tunnel cannot exist. Even at v1, default-deny still blocks all lateral in-cluster movement, all
  non-allowlisted ports, and any plaintext exfil.

### Layer 4 — Distroless image + hardened securityContext _(defense-in-depth)_

- **Distroless-node**: no shell, no coreutils, no `rg`. Pi's un-overridden `LocalShell` / local-`rg`
  paths fail closed at `ENOENT` instead of executing.
- **securityContext** per H8. Read-only rootfs blocks the model-code-writes-a-dropper class; dropped
  caps + non-root + seccomp shrink what any in-pod code can do.
- **Honest limit (H10):** Node is still a runtime — `child_process.spawn('/bin/sh')` fails (no sh),
  but `fs.readFile` (on read-only mounts) and `net`/`http` still work. Distroless kills the
  shell/coreutils class; the NetworkPolicy kills the network class. Necessary, not sufficient, alone.

### Layer 5 — Least-privilege RBAC _(defense-in-depth)_

- The harness SA **needs** `create pods/exec` to drive the sandbox; don't drop the token.
- Scope it to exec **only on sandbox pods** (dedicated namespace + label selector). No `get/list
secrets`, no exec on arbitrary pods. This constrains the one genuine privilege the harness holds —
  the thing local-exec'd code would most want to abuse.

_Optional belt-and-suspenders:_ if Pi's API allows **removing** (not just overriding) the local
Operations implementations at startup, do it — then the local handlers aren't present in-process,
partially addressing H10. Only if clean; don't fight the framework.

---

## 5. What this buys — and what it removes

**Removes (vs. the parent/M13 reflex applied to the harness):**

- **No forward egress proxy** for the harness.
- **No baked CA / TLS interception** of the harness's traffic.
- **No placeholder-swap, no allowlist machinery, no per-host policy** at the harness.

Those exist to tame _arbitrary model-controlled egress_, which the harness does not have (§2.4).

**Buys:**

- Local execution in the harness becomes **boring**: nothing to steal (L2), nowhere to send it (L3),
  little to run (L4), and it mostly **cannot happen** at all (L1).
- The harness's provider-key property from parent §2.2 (claim 1) is preserved **structurally** — the
  key can't reach the durable log because it's never in the harness — at a fraction of the cost.
- A clean, kernel-enforced network boundary that does not depend on enumerating Pi's every
  local-exec path (a losing game across version bumps, as `grep` already showed).

**Honest residue (§8 expands):** L2's guarantee bounds _raw-key exfiltration_, not _use_ — a popped
harness can still ask the injector to proxy provider calls while alive. And the injector pod becomes
a higher-value target (holds the key, sees prompts); that is the subject of the next spec.

---

## 6. Failure modes & caveats

- **Sandbox config missing/unreachable** → harness **refuses to run** (L1), loud error; it does _not_
  silently fall back to local tools. (This is the intended new behavior.)
- **A future Pi tool/path not overridden** → it may attempt local execution, but: no shell (L4), no
  secret (L2), no internet route (L3), and scoped RBAC (L5). Defanged rather than perfectly
  prevented.
- **Harness process compromise (RCE in trusted code)** → can _use_ the injector (proxy provider
  calls) and write Redis while alive, but cannot exfiltrate the raw key or reach arbitrary hosts.
  Blast radius bounded to the pod's lifetime and its allowed in-cluster peers.
- **NetworkPolicy not enforced by the CNI** → L3 silently no-ops. Deployment must assert a
  policy-enforcing CNI; otherwise the exfil boundary is absent and only L1/L2/L4 remain.
- **Distroless misread as sufficient** → H10. Do not drop L3 because the image is distroless.

---

## 7. Verification gate

The harness lock-down passes when, on a Kind cluster with the zero-trust harness deployment:

1. **Fail-closed:** with sandbox config removed/unresolvable, the harness **refuses to run a turn**
   (loud error) and does **not** register or execute local tools. With config present, all 7 tools
   route to the sandbox pod (M2/M3 behavior intact).
2. **Secret-free:** a red-team `grep` finds the provider key **absent** from the harness container
   env, the reconstructed prompt, and every Redis log entry — while inference still succeeds (via the
   injector).
3. **No exfil route:** from inside the harness container, an outbound connection to an arbitrary
   public host on `:443` **fails**; connections to `{API server, Redis, injector}` succeed.
   _This gate requires a policy-enforcing CNI and therefore runs on **OCP (OVN-Kubernetes)**, not the
   Kind base — kindnet does not enforce egress policy, so there the manifest is present but a no-op
   (Z2 §6). Note that **pre-M8**, arbitrary-host `:443` still succeeds by construction (the LLM is
   external); it is the injector end-state that makes it fail. The CNI-independent half — that the
   manifest has the right **shape** (default-deny egress, correct Knative pod selector, only the
   `{DNS, Redis, HTTPS}` allowlist, and both kustomizations wiring it in) — is asserted in CI by
   `packages/knative-server/test/harness-egress-policy.test.ts`._
   - **Liveness under the policy:** the OCP gate must also confirm the harness pod reaches and **holds
     `Ready`** with the policy applied — including a **scale-from-zero** — so that the Knative
     **queue-proxy** sidecar's own control-plane egress needs are covered by the allowlist. Queue-proxy
     shares the pod netns, so a default-deny egress that omits one of its egress peers can silently
     **starve the sidecar** and surface only as a failed scale-up (the pod never goes `Ready`), not as
     an obvious connection error. Assert readiness + a successful cold-start request, not just
     LLM/Redis/API reachability. (Autoscaler metrics are _scraped_ — ingress to the pod — and this
     policy is `Egress`-only, so that path is unaffected; the check guards against any egress peer we
     have not enumerated.)
4. **Local-exec defanged:** a forced un-routed local-exec attempt (e.g. a tool that would spawn a
   local shell) **fails** — no shell present (L4) and, were it present, no route out (L3).
5. **Least privilege:** the harness SA **cannot** exec into a non-sandbox pod and **cannot** read
   Secrets.

---

## 8. Consequences & trade-offs (recorded honestly)

1. **Deployment-mode divergence.** The harness now has a "zero-trust" mode (fail-closed, secret-free,
   network-jailed) distinct from a local dev run (local tools fine). One code path, two postures
   gated by config — must be documented so a dev run isn't mistaken for a hardened one.
2. **The injector becomes the high-value target.** Concentrating the key + public egress + prompt
   visibility in one pod is the cost of the clean boundary. Mitigations (trusted code, mTLS/SPIFFE
   gating, budget enforcement, key rotation) are the **next spec**'s job.
3. **`use` vs. `exfiltrate` residue.** L2 bounds raw-key leakage, not key use by a live compromised
   harness. Accepted; it is a large reduction _because the log is durable_, and a full fix would
   require attesting the harness process itself (out of scope).
4. **CNI dependency.** L3 is only as real as the cluster's NetworkPolicy enforcement.
5. **Distroless operational cost.** No shell in the image complicates in-container debugging; use an
   ephemeral debug container (`kubectl debug`) rather than baking tools back in.
6. **Separate injector pod adds one in-cluster hop** on inference (H6). Negligible against LLM
   round-trip latency, and it buys the enforceable boundary.

---

## 9. References

- [Zero-Trust, Multi-Agent Extensions](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) — §2 spine, §2.2 the harness-holds-no-key claim this design preserves structurally, §3.1 inference broker (placement refined here), §4.1 log invariants + red-team grep.
- [M2 — `K8sSandboxClient`](2026-06-17-m2-k8s-sandbox-client-design.md) — the override-based tool redirection this design makes fail-closed; `extension.ts:47` gate; `grep-tool.ts` local-`rg` special case.
- [M3 — Persistent channel](2026-06-17-m3-persistent-channel-design.md) — the transport the redirected tools ride.
- [M4 — Knative wrapper](2026-06-17-m4-knative-serverless-wrapper-design.md) — `runTurn`, the scale-to-zero deployment this posture applies to.
- [M13 — Generalized Credentialed Egress](2026-06-19-m13-generalized-credentialed-egress-design.md) — the **sandbox** egress plane this design argues does **not** extend to the harness.
- Kubernetes: per-container env/mount scoping; per-pod NetworkPolicy granularity; Pod `securityContext`; distroless images.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
