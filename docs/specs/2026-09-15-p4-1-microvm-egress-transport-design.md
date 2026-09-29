# P4.1 — MicroVM egress transport: reaching Z5's credentialed-egress proxy from a Firecracker guest — Design

**Status:** design (proposed) · **Track:** P (sub-slice of P4) · **Date:** 2026-09-15
**Consumes:** [Z5 — Generalized credentialed egress](2026-06-19-m13-generalized-credentialed-egress-design.md),
[RC1 — AuthBridge egress control-plane PoC](2026-07-10-authbridge-egress-control-plane-poc-design.md) Profile B
**Extends:** [P4 — MicroVM sandbox tier](2026-09-09-p4-microvm-sandbox-design.md)
**Touches:** Z1 (identity spine) — partially, and behind an interface · MU2 (`sandbox-egress` credential delivery)

## 1. What this is, and what it is not

**It is not a new egress design.** Z5 settled credentialed egress in June: forward proxy, baked CA, TLS
interception, placeholder-swap, allowlist-as-exfil-boundary, proxy-as-sole-enforcement-point (Z5 §2,
decisions E1–E11). RC1 implemented a static slice of it (RC1-2, live on Kind and OCP). Anyone reaching
for "how should the sandbox make a credentialed call" should read Z5, not this.

**It is a transport adapter.** Z5 assumes `HTTPS_PROXY` reaches the proxy over ordinary IP networking,
because Z5's sandbox is a pod. The P4 microVM tier has **no network device at all** — no tap, no
`/network-interfaces` call, no NAT anywhere in `deploy/microvm/`. The only guest↔host channel is vsock,
where the guest agent is parked in `accept()` on port 1024 (`deploy/microvm/build-snapshot.sh:561`). So
Z5's mechanism is unreachable on this tier for a purely mechanical reason, and this slice supplies the
missing hop.

Three things follow that Z5 and RC1 could not have anticipated, and they are the substance here: the
transport (§4), a topology change that pulls in a Z1 decision (§5), and the golden snapshot's
constraints on a baked CA and a baked placeholder (§4, T5–T6).

### 1.1 A caution, recorded because it already cost time

This design was initially re-derived from first principles, reaching Z5's E2/E3/E7/E9/E11 independently
and calling them new. The milestone registry ([`README.md`](README.md)) is one grep from any of them.
**Read the registry before designing anything in the egress or credential space.** It exists because two
work streams already collided over `M`-numbers once.

## 2. Why the naive options are worse

| Option                          | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Give each microVM a NIC         | Firecracker restores NICs onto the originally-configured tap name and every clone resumes with the **same guest IP** ([`network-for-clones`](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/network-for-clones.md)). The documented workaround is a netns + veth pair + double MASQUERADE **per clone** — 128 netns and 128 veth pairs at E11's ladder top — and Firecracker's own doc disclaims it as "just an example… not a performant or secure setup" |
| virtio-fs the knowledge base in | **Firecracker has no virtio-fs** (P4 §2.4, cited). Block devices are its only host-sharing mechanism, which is _why_ Cloud Hypervisor was in P4's scope at all (P4 §4.3)                                                                                                                                                                                                                                                                                                                   |
| NFS/CIFS mount for shared data  | Requires the NIC above, and puts host filesystem trust inside a guest that runs model-authored code                                                                                                                                                                                                                                                                                                                                                                                        |

**And none is needed.** A knowledge base that is _queried_ rather than _walked_, and long-term agent
memory that lives in "external databases, vector stores, or knowledge graphs", are both **allowlisted
destinations in Z5's existing model**. No host filesystem mount appears anywhere in this design.
Firecracker's missing virtio-fs constrains a mechanism this tier does not use.

## 3. Scope

**In scope:** the vsock hop from guest to Z5's proxy; the shared-proxy topology and the caller-identity
interface it requires; the golden-snapshot constraints on the CA and the placeholder; the E12 probe that
gates the mechanism; the verification gate.

**Out of scope:**

- **Any change to Z5's decisions.** Resolver selection, allowlist semantics, audit shape, budget and cap
  are Z5's and RC1's. This slice changes only what sits behind `127.0.0.1:3128`.
- **Z1's harness→gateway hop.** §5's identity mechanism is scoped to sandbox→proxy on this tier and takes
  no position on the hop Z1 exists for.
- **Per-user credential provisioning.** MU2 owns `sandbox-egress` credential delivery (registry, `MU` table).
- **Session-scoped working memory.** P4 keys the workspace on the **run** (`workspace_key` is "populated by
  the harness from the lease's run id", P4 §3.4), so short-term memory cannot span a session's turns. P4 §9
  sidesteps this by keeping interactive `/turn` on the container tier. A real gap, filed as
  [#267](https://github.com/rossoctl/moca/issues/267), not fixed here.
- **Non-HTTP protocols.** `ssh` and anything on raw sockets do not work on this tier, by construction (§7).

## 4. Key decisions

| #      | Decision          | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1** | Transport         | **vsock.** Guest loopback listener → `CID 2:1025` → `<jail>/run/v.sock_1025`. Z5's `HTTPS_PROXY` contract (Z5 E3) is **unchanged**; only what answers on `127.0.0.1:3128` differs. Guest-initiated vsock needs **no handshake** — Firecracker forwards to the correspondingly-named Unix socket, which the host must pre-create ([`vsock.md`](https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md))                                                                                        |
| **T2** | Forwarder home    | **The existing guest agent**, already parked on vsock:1024 and already in the golden snapshot. One binary, not two. Its new loopback listener is guest-internal TCP — no host-side resource to remap at restore                                                                                                                                                                                                                                                                                                   |
| **T3** | Proxy topology    | **One shared proxy per host**, _not_ RC1 Profile B's per-sandbox sidecar. Forced by arithmetic: E11 measured Σ PSS **0.41 GB for 128 resident microVMs**; 128 sidecar proxies would each cost more than the VM they serve                                                                                                                                                                                                                                                                                         |
| **T4** | Caller identity   | **An interface, not a mechanism.** First implementation: the **accepting socket path**, which is per-jail and unforgeable from inside the guest. Second implementation may be SPIFFE. See §5 — T3 makes identity mandatory, and identity is Z1's                                                                                                                                                                                                                                                                  |
| **T5** | Placeholder shape | **Constant, image-shipped** — Z5 §4.3's own second option ("the image can ship standard placeholders"). _Not_ `placeholderFor(subject)`: a subject-named placeholder cannot live in a snapshot restored N times (P4 §5.2) and would let the guest name a subject. MU1's inference consumer keeps `placeholderFor`; two consumers, two shapes                                                                                                                                                                      |
| **T6** | CA                | Host CA **public** cert in the read-only rootfs. "A trust anchor, not a secret" (Z5 E3), identical across every VM, so P4 §5.2's no-secrets-in-the-snapshot invariant holds                                                                                                                                                                                                                                                                                                                                       |
| **T7** | Bypass            | **Structurally impossible, not policy-enforced.** Z5 §5.1 concedes the model "can address any host… ignore any wrapper", and §8.6 leans on NetworkPolicy to contain it. With no network device there is nothing to bypass _to_. This tier makes **Z5 E4**'s "curl to anywhere is structurally impossible" literally true. (Z5's decision labels `E1`–`E11` collide with this repo's _experiment_ numbers `E1`–`E11`; every decision reference here carries the `Z5` prefix, and bare `E12`–`E14` are experiments) |

## 5. The interlock T3 creates, and why it is behind an interface

**RC1 could defer Z1 because Profile B is per-sandbox.** RC1 records "PoC is single-tenant/static; **no
per-caller identity**" — legitimate, because a co-located sidecar _is_ the identity. T3 removes that: a
proxy shared by 128 guests must distinguish callers, and per-caller identity is Z1's subject.

**The socket path supplies it without SPIFFE.** Each VM has its own jailer chroot (P4 §5.3), so its
`v.sock_1025` is a distinct path the guest cannot rename, relocate, or reach a sibling's copy of. The
proxy learns _which session is calling_ from **which socket accepted the connection** — the guest
transmits no identity and has no channel to. `packages/control-plane/src/exchange.ts:41-46` records the
current weakness as "any code in the harness pod can call the exchange… the CALLER identified per session
rather than per deployment", waiting on Z1/SPIFFE. This is that property, on this tier, today.

**It ships behind an interface anyway.** A `CallerIdentity` resolver with one real implementation (socket
path) and a declared second (SPIFFE), so the tier ships without settling whether jail-path identity is a
sanctioned pattern or a tier-local exception. **Cost, stated plainly:** an abstraction with a single
implementation, which is ordinarily a smell. It is accepted here because the alternative is either
blocking on Z1 or quietly establishing a second identity substrate — and the registry records what
happened last time two schemes accreted unowned.

**Z1 keeps the question.** This slice claims a scoped, tier-local discharge for one hop. It does not claim
jail-path identity generalises, and it does not touch harness→gateway.

## 6. Request path

```
GUEST (runs model-authored code)          │ HOST (trusted)
                                          │
 gh / curl / MCP-over-HTTP                │
   HTTPS_PROXY=http://127.0.0.1:3128      │
   GH_TOKEN=<constant inert placeholder>  │
   CA public cert in trust store          │
       │                                  │
       ▼                                  │
 guest agent ─── vsock CID 2:1025 ────────▶ <jail>/run/v.sock_1025
 (already parked on 1024)                 │      │
                                          │      │  the accepting path IS the identity
                                          │      ▼
                                          │  shared egress proxy  ──▶ control plane
                                          │  Z5: terminate · allowlist       consumer:
                                          │      swap placeholder · audit    sandbox-egress
                                          │      cap                              │
                                          │      │ ◀────────────────────────────────┘
                                          │      ▼
                                          │  upstream: api.github.com · KB index · memory store
```

**Ordering that matters.** The host must be listening on `_1025` **before** the guest connects, so the
socket is created at **replenishment**, off the hot path, and a VM becomes a standby **only after** its
listener verifies — fail-closed, matching P4 §3.4's refusal of an empty `workspace_key`. Restore passes
`vsock_override` for this jail's prefix; the `_PORT` suffix follows the new prefix automatically. At
teardown the VM is SIGKILLed **first**, then the socket unlinked; reversing that lets a dying guest's
in-flight request hit a socket whose jail is being removed.

**Credentials must be cached per session in the proxy.** Not an optimisation: `exchange.ts:10-12` requires
the control plane to be "on the CONTROL path once per turn — never on the data path."

**No DNS in the guest.** The proxy resolves hostnames, so the guest needs no `resolv.conf` and no
nameserver — and none of the guest-side renumbering Firecracker's clone recipe requires.

## 7. The compatibility boundary, stated rather than discovered

Mediated L7 means **tools that ignore proxy environment variables have no network.** `curl`, `git`, `gh`
and HTTP-transport MCP honour it; stdio-transport MCP servers run in-guest and need nothing. `ssh`, raw
sockets, and anything doing its own DNS do not work. `NO_PROXY` must be empty.

This is the price of T1 and T7 together, and it is the same trade Z5 §5.2 already accepted for
cert-pinning clients — narrower here, because on this tier the documented "route it around the proxy"
exception **does not exist**. A pinning upstream cannot be worked around on the microVM tier at all; it
must be reached from the container tier or not at all. **That is a real regression against Z5 §5.2 and it
is not mitigated.**

## 8. Failure modes

| Failure                          | Behaviour                                                                | Note                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| No `_1025` listener              | Firecracker returns `VIRTIO_VSOCK_OP_RST`; guest sees connection refused | Unreachable if standby verification holds. Fail-closed                                                                   |
| **Shared proxy crashes**         | **Every guest on the host loses egress at once**                         | The cost of T3. Blast radius is host-wide where RC1's sidecar was per-sandbox. Needs supervision (`packages/supervisor`) |
| Destination off allowlist        | Refused at the proxy (Z5 E4), naming the host                            | Never a timeout: a timeout is retried, a named refusal is reported                                                       |
| No credential for subject        | `401`, request never leaves the host                                     | Inherits RC1's fail-closed `token-broker`. Must not pass through unauthenticated                                         |
| Upstream pins certs              | TLS fails inside the guest, opaquely                                     | §7. No exception path exists on this tier                                                                                |
| **vsock reset across restore**   | **Unknown**                                                              | Firecracker's `vsock.md` states "vsock snapshot support is currently limited" with a device-reset limitation. E12        |
| Guest forges a subject           | Ignored — subject comes from T4, never from the request                  | Z5 E11's `(subject ⊕ destination)` keying is the second defence                                                          |
| Guest reaches a sibling's socket | Impossible — the jailer chroot is the confinement (P4 §3.5, §5.3)        | The sibling's socket is not in this jail's filesystem                                                                    |
| Guest floods connections         | One guest exhausts the shared proxy's fds                                | Per-VM connection cap required. A T3 consequence RC1 did not have                                                        |

## 9. Experiments

> **STATUS, 2026-09-22 — E12 has answered: yes. T1 stands, and the hold below is lifted.**
> [#271](https://github.com/rossoctl/moca/issues/271) is closed COMPLETED and
> [#273](https://github.com/rossoctl/moca/pull/273) is merged. `EXPERIMENTS.md`'s E12
> section records rungs A, B, D and C@8 passing with two independent witnesses and the
> pristine-snapshot check intact, so a guest-initiated connection on a second vsock port does
> survive restore and the NIC option does not return. Rung C@128's dropped connections were traced
> to the probe's own scaffolding rather than the restore mechanism — `start_host_listener` returned
> as soon as the listener process was backgrounded rather than when it had reached `listen()`, so a
> guest CONNECT could land before anything was listening and be answered with a correct RST. Fixed
> in `b203e38`, confirmed on both substrates; see E13. The probe's guest helper has also landed, as
> `remote-worker/cmd/e12-guest-client`.
>
> The gating language below is kept as the record of what was sealed before the run, not as live
> guidance. **E13 and E14 are still open**, and the text below still governs them.

**E12 gates everything and can invalidate T1.** P4 §2.4 establishes that _listening_ vsock sockets survive
restore in the _host-initiated_ direction. This design adds a **second port** in the **guest-initiated**
direction across restore, and neither the repo nor Firecracker's docs establish that it works. If E12
fails, T1 is dead and the NIC option in §2 returns. **Build nothing before E12 answers** — the hold as
written before the run; **discharged, see the status note above.** E12 was tracked independently as
[#271](https://github.com/rossoctl/moca/issues/271), written to be picked up without
implementing any of this spec.

| #       | Question                                                                                                           | Substrate                          | Falsifiable prediction, to seal before running                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E12** | Does a guest-initiated connection on a second vsock port work after restore, and after N restores of one snapshot? | `nested-m8i` (§9.1)                | **Works for all N.** Guest-initiated needs no handshake and no host-side state beyond the socket file, so there is strictly less to reset than in the direction already known to work. **Scored: held on the mechanism, not literally as stated** — see below |
| **E13** | Added latency per HTTP request through the proxy vs. the container tier's direct call                              | `metal`, or nested × #266's ratio  | **< 5 ms p50 added.** The hop is host-local; E10 puts `run` at 2.85 ms of a 55.32 ms warm action                                                                                                                                                              |
| **E14** | Does one shared proxy with 128 listeners move E11's knee?                                                          | `metal`, or nested once #266 lands | **Knee stays at c=8 and `bound` stays `replenishment`.** E11 measured `hostCpuFraction` 0.001 flat and Σ PSS 0.41 GB at 128 VMs                                                                                                                               |

E13 and E14 reuse E10's and E11's drivers and P4 §7.1's `bound` vocabulary unchanged. Predictions are
sealed in `deploy/microvm/predictions.json` before the first rung, per P4's practice.

**E12's prediction is scored honestly rather than rounded to a pass.** Its reasoning — "strictly
less to reset than in the direction already known to work" — was right, and that is the part this
spec depends on. But "works for all N" did not hold on first pass: the authoritative pre-fix
combined run produced 76/128 at N=128 and `ok=false` in `e12-answer.json`. It holds only **after a
defect in the probe's own startup ordering was corrected** (`b203e38`, #273), which cut the failure
rate 167.8x on metal and took the guest-side-reset signature to zero across 5,120 VM-attempts, and
to zero on `nested-m8i` as well. A residual, substrate-specific failure mode remains on nested that
is iowait-correlated and unrelated to the vsock mechanism. Recording it this way matters because
this repo seals predictions before the first rung precisely so they cannot be quietly reinterpreted
afterwards: a prediction that needed the rig fixed before it passed is a different record from a
clean first-pass hit, even when the mechanism it claimed is vindicated.

### 9.1 Why E12 belongs on the nested rig, and must not share metal's snapshot

**E12 is a boolean, not a measurement.** It has no threshold, no baseline and no ladder — so it needs
neither metal's absolute fidelity nor an E10/E11 re-run to compare against. `e10-lifecycle.sh` prints a
STOP/MANDATORY verdict only when `SH_SUBSTRATE` is exactly `"metal"`, which is the right structure here:
E12 has no verdict to print, only a yes or a no.

**Sharing metal's snapshot would silently break someone else's result.** E12's guest needs a
vsock-_initiating_ client in the rootfs, and that changes the rootfs digest. The authoritative E10/E11
numbers were legitimised precisely by that digest being verified identical before and after every run
(`sha256:668af589...` — quoted at the same truncation `EXPERIMENTS.md` records, since nothing
committed to this repo carries more of it). Folding E12's helper into the snapshot a repeat metal
run uses would invalidate the comparison that run exists to make — and it would do so invisibly. [#266](https://github.com/rossoctl/moca/issues/266)
reaches the same conclusion from the other side (its open question 4: Firecracker restores only on
identical hardware, so a nested rig needs its own snapshot regardless). Building E12's snapshot on
`nested-m8i` therefore contaminates nothing, and costs no metal time on a box that is currently contended.

**Nested is the harsher substrate for this specific question**, since it "taxes exactly the VM-exit-heavy
work restore consists of" (`EXPERIMENTS.md`) — so a pass there is a _stronger_ result than a pass on metal,
not a weaker one. **Residual, stated rather than buried:** restore requires identical hardware, so a nested
pass does not _prove_ the metal case. It makes it very likely; metal confirmation rides along with whichever
later run builds a metal snapshot anyway, and is not worth booking metal time for on its own.

**E14 acquires a dependency from this.** Its prediction is that the knee stays at `c=8` _because of the
proxy_ — which presumes a known knee on whatever substrate it runs. #266's open question 3 asks whether the
knee moves under nesting at all. So E14 on nested is only interpretable **after** #266 establishes the
nested knee; on metal it is interpretable immediately. E13 is the milder case: an absolute millisecond claim
wants metal, or nested scaled by #266's ratio.

## 10. Verification gate

Z5 §9's criteria 1, 2, 5 and 6 apply **unchanged** and are not restated. This slice adds:

| Gate                                   | What it proves                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Real credential never in the guest** | After a successful authenticated request, the credential is absent from guest env, filesystem and memory. The transport analogue of P4 §8's cross-run-bleed gate |
| **The placeholder is inert**           | The placeholder sent _directly_ to upstream returns `401`. Without this, the gate above can pass because the guest's own token happened to work                  |
| **Subject forgery is ignored**         | A guest presenting another subject's placeholder gets its own credential or a refusal — never the other's. Tests T5 and T4, not their comments                   |
| **Sibling sockets unreachable**        | VM A cannot reach VM B's `v.sock_1025`. Nominally guaranteed by the chroot, which is exactly why it is worth asserting the chroot is in force                    |
| **No DNS in the guest**                | Egress works with no `resolv.conf`. Also a regression fence against a NIC being added quietly later                                                              |
| **Fail-closed standby**                | A jail whose listener failed to bind never becomes a standby                                                                                                     |
| **Teardown ordering**                  | An in-flight request during SIGKILL yields a counted error and no orphan socket                                                                                  |
| **Bypass is impossible (T7)**          | A guest attempting a direct outbound socket fails for want of any network device — not for want of a policy                                                      |

## 11. Consequences, recorded honestly

1. **Host-wide egress blast radius** (T3). RC1's per-sandbox sidecar failed one sandbox at a time.
2. **An interface with one implementation** (T4), accepted for the reason in §5, and a scoped incursion
   into territory Z1 owns.
3. **No cert-pinning escape hatch** (§7). A strict regression against Z5 §5.2, unmitigated.
4. **The audit log is new attack surface.** It records full URLs, and some upstreams carry secrets in query
   strings. Needs a redaction rule — named here rather than discovered in review.
5. **T1 is unproven.** E12 may end this design. Recorded as the first task, not the last.
6. **No claim the proxy cannot be escaped.** Same posture as P4 §1's refusal to claim the VMM cannot be: we
   claim the credential moved, not that the boundary is unbreakable.

## 12. Implementation notes for a fresh session

Mirrors P4 §10's purpose: decide what can be decided, so a planner starting cold does not have to guess.

**[#271](https://github.com/rossoctl/moca/issues/271) (E12) has answered yes, so this
work is unblocked** — see the status note at the head of §9. The gate that stood here is discharged,
not merely stale: T1 is confirmed, and `remote-worker/cmd/e12-guest-client` is already on `main`.
E13 and E14 remain open, but neither gates the slice below.

### 12.1 Files this slice touches — settled

| Path                                                                 | Change                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remote-worker/cmd/guest-agent`, `remote-worker/internal/guestagent` | T2: the guest agent gains a **loopback TCP listener** on `127.0.0.1:3128` that splices each accepted connection to `CID 2:1025`. The existing framed vsock protocol in `internal/guestagent/protocol.go` is **not** involved — egress is opaque byte-splicing, not framed requests. Built static (`CGO_ENABLED=0`) exactly as now                     |
| `remote-worker/internal/vmpool/`                                     | Replenishment creates `<jail>/run/v.sock_1025` **before** restore and marks the VM standby only once the listener verifies (fail-closed); restore passes `vsock_override` for the jail's prefix; teardown SIGKILLs the VM **then** unlinks the socket (§6's ordering)                                                                                 |
| `deploy/microvm/build-snapshot.sh`                                   | Rootfs additions: the host CA **public** cert into the trust store (T6), and the constant inert placeholder plus `HTTPS_PROXY=http://127.0.0.1:3128` / empty `NO_PROXY` as image-shipped env (T5). All three are constants, so none violates P4 §5.2. The script's `--agent` flow and its heredoc `guest_client.go` build-time verifier are untouched |
| `deploy/microvm/predictions.json`                                    | E13/E14 predictions, sealed before their first rung (E12's is #271's)                                                                                                                                                                                                                                                                                 |
| `deploy/microvm/EXPERIMENTS.md`                                      | E13/E14 sections                                                                                                                                                                                                                                                                                                                                      |
| `docs/specs/README.md`                                               | Registry row — **already done in this PR**                                                                                                                                                                                                                                                                                                            |

**Language follows location:** everything above is Go, because jail creation and the guest agent already
are. No `packages/` (TypeScript) change is implied by anything in §12.1.

### 12.2 The proxy component — an owed decision, not a deferral

§6 calls it "the shared egress proxy" without saying what it _is_, and that is deliberate: the choice
changes the file list, the language and whether a second repository is in play, and it should be made
with a planner's view rather than pre-empted here. Recorded in the shape P4 §4.5 uses for the repo-cache
shapes — the options and what discriminates them, so the decision is bounded rather than open.

The complication: **RC1's Profile B is a Kubernetes sidecar** (`deploy/knative/sandbox-pool-ab2.yaml`,
`deploy/knative/authbridge/`), "co-located, ships WITH the sandbox." This tier has no pods and no
sidecars, and T3 makes the proxy shared rather than co-located, so RC1's deployment shape does not
transfer even though its plugin semantics do.

| Option                                                                                                                                                               | Gains                                                                                                                | Costs                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. AuthBridge as a plain host process** — RC1's `mcp-parser → SPARC → token-broker` chain plus `static-broker`, under systemd instead of a sidecar                 | Z5 semantics, fail-closed `token-broker` and the audit shape inherited unmodified; no second implementation to drift | AuthBridge is outside this repo and its deployment model is Kubernetes-shaped; it must learn vsock listeners **and** the socket-path `CallerIdentity` — changes in someone else's codebase                 |
| **2. A new host-side proxy here** — a Go package beside `remote-worker`                                                                                              | Host-native, no cross-repo dependency, `CallerIdentity` is natural, full control of the vsock listener lifecycle     | Re-implements allowlist, placeholder swap, audit and cap — which Z5 E9 assigns to the proxy it already specified. Two implementations of one security boundary is the failure mode Z5 E1 exists to prevent |
| **3. Thin host shim in front of AuthBridge** — a small Go shim owns the vsock listeners and socket-path identity, forwards to an unmodified AuthBridge over loopback | Z5's brain untouched; all new code stays in this repo; the density win of T3 is preserved                            | An extra hop, and the identity header between shim and AuthBridge becomes a trust boundary that **must not** be settable by the guest — the shim has to strip it from inbound requests                     |

**What discriminates them:** whether AuthBridge can accept a vsock listener and a non-header identity
source without forking it. If yes, option 1. If no, option 3 is option 1 with the incompatibility
isolated in this repo, and it is the presumptive answer. Option 2 only wins if Z5's semantics turn out
not to fit a shared, non-Kubernetes proxy at all — which would be a finding about Z5, and should be
written up as one rather than absorbed silently.

## 13. References

- [Z5 / M13 — Generalized credentialed egress](2026-06-19-m13-generalized-credentialed-egress-design.md) — E1–E11; §4.3 placeholder mechanics; §5.1 the proxy is the only boundary; §5.2 why TLS interception is acceptable; §8.6 the NetworkPolicy dependency T7 removes
- [RC1 — AuthBridge egress control-plane PoC](2026-07-10-authbridge-egress-control-plane-poc-design.md) — Profile B, the per-sandbox sidecar T3 replaces; fail-closed `token-broker`; the deferred Z1 note §5 acts on
- [P4 — MicroVM sandbox tier](2026-09-09-p4-microvm-sandbox-design.md) — §2.4 platform facts incl. no virtio-fs; §3.4 `workspace_key`; §3.5 and §5.3 the jail as confinement; §5.2 nothing unique in the snapshot; §8 the bleed gate
- [Milestone registry](README.md) — P-track, Z-track, MU2's `sandbox-egress` ownership
- [#266](https://github.com/rossoctl/moca/issues/266) — metal/nested ratio for the E10/E11 ladders; its open question 3 (does the knee move under nesting?) gates E14 on nested, and its question 4 (a nested rig needs its own snapshot) is why §9.1's snapshot separation is free
- [#267](https://github.com/rossoctl/moca/issues/267) — the session-scoped working-memory gap §3 puts out of scope
- [#271](https://github.com/rossoctl/moca/issues/271) — E12, the gating probe, specified to be executable independently of this spec
- Firecracker [`vsock.md`](https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md) — guest-initiated `<uds>_<PORT>` convention, no handshake, `vsock_override`, "vsock snapshot support is currently limited"
- Firecracker [`network-for-clones.md`](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/network-for-clones.md) — the netns/veth/MASQUERADE recipe §2 rejects, and its own disclaimer
- `packages/control-plane/src/credential-store.ts:13` — `sandbox-egress` as an existing `Consumer`
- `packages/control-plane/src/exchange.ts:10-12`, `:26-33`, `:41-46` — control-path-only invariant, `placeholderFor`, the per-caller identity weakness §5 addresses

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
