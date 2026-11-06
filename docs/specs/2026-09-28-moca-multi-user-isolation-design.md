# MI1 — Multi-user isolation on the density substrate: per-session skills and credentials — Design

Version: 1.0 — September 28, 2026
Status: Proposed
Scope: Make a P6 worker process safe to hold **sessions of different users at the same time**, for the
two things that are per-session rather than per-deployment: the **promoted config bundle** (skills,
context, memory) and **credentials** (inert placeholders, swapped for real values only at an egress
proxy). Covers both sandbox tiers the Kubernetes-free deployment ships: the **container tier**
(`deploy/compose`, `deploy/vm`) and the **P4 microVM tier** (`deploy/microvm`).
Milestone: **MI1**, a new `MI` (multi-user isolation) track — its own prefix, like `RA` and `MU`,
because it cuts across the `P` density track (P4, P4.1, P6), the `MU` product track (MU1, MU2) and
the `Z` credential track (Z1, Z5). Source of truth for numbering: [Milestone Registry](README.md).
Builds on: [P6](2026-09-08-p6-vm-process-manager-design.md) ·
[P4](2026-09-09-p4-microvm-sandbox-design.md) · [P4.1](2026-09-15-p4-1-microvm-egress-transport-design.md) ·
[P5](2026-09-06-p5-session-isolation-design.md) · [MU1](2026-09-08-multi-user-control-plane-design.md) ·
[workflow promotion](2026-09-02-claude-code-workflow-promotion-design.md) ·
[Z1](2026-06-26-identity-spine-design.md) · [Z5](2026-06-19-m13-generalized-credentialed-egress-design.md) ·
[RA1](2026-09-24-ra1-density-cutover-and-repo-rearchitecture-design.md).
Amends: P4.1 §12.2 (proxy choice), P5 §3.2 (subject-derived placeholder), MU1 §5.3 (credential
exchange), the promotion design §4.4–§4.5 (harness-side unpack, shared sandbox cache). See §14.
Decision record: to be written with the S2 slice (§14), at the next free number. _ADR-0037 is taken (P6 on Kubernetes); see the 2026-10-26 amendment._
Naming: new components and settings use the **MOCA** name from day one (`moca-egress`,
`MOCA_*`); existing `SH_*` names are left for RA1 Phase 1's rename.

> **Amendment, 2026-11-05 — owned async dispatch is `async:true` on a session, not `/v1/runs`, and
> `turn_exp` is unbuilt.** §6.5 and §10 describe owned asynchronous runs as `/v1/runs`;
> [#279](https://github.com/rossoctl/moca/issues/279) resolved that there is no `run` noun and no
> second `/v1/runs`, so read those as **`POST /v1/sessions/{id}/turns {async:true}`** per
> [P6AF](2026-11-05-p6-async-fan-out-design.md) §4.1
> ([ADR-0047](../adrs/0047-p6-async-fan-out-in-worker-drain.md)).
> R7's `501 async_runs_unavailable` is superseded twice over: #691 removed the data-plane async
> route (`400 async_removed`), and P6AF §4.2 keeps it removed permanently — the replacement is the
> authenticated path above, not a restored `/v1/runs`. §6.5's actual requirement, that no bearer
> token is ever written to the queue, is unchanged and is what P6AF §5.4 implements.
>
> Two findings S2 needs regardless of async fan-out: **`turn_exp` (§6.1) is specified here and
> implemented nowhere in TypeScript** — expiry is always `exp = iat + ttlSeconds`, clamped only for
> sandbox tokens by the resource's own `expiresAt` — and for a queued turn, "turn start" must mean
> **dequeue, not enqueue**, which §6.1 does not currently pin down. P6AF M1 uses this section's own
> single-tenancy interim and is deliberately sequenced before S2; its M2 consumes S2 (P6AF §9.1).

> **Amendment, 2026-10-26 — the SBX path takes a different route to S4's credentials.** For
> `mocactl sbx` microVMs, [SBX0.2b](2026-10-26-sbx-egress-credentials-design.md)
> ([ADR-0046](../adrs/0046-sbx-egress-credentials-owner-lookup.md)) delivers `sandbox-egress`
> credentials without S2's grants. Phase 1 resolves them by sandbox owner with a per-host bearer.
> Phase 2 carries SBX0's existing sandbox token on `Exec.grant` (§8.2) and on `Register`/`Rebind`
> (§8.3), so it plays the sandbox grant's role on that path. It implements §8.5 items 4–5 and §8.7
> (interception, the CA), which S4 reuses for the harness's own sessions. S2 still governs harness
> sessions, which are unchanged. Separately, the "ADR-0037" this spec names for its decision
> record is taken (ADR-0037 is P6 on Kubernetes), so MI1's record takes the next free number when
> S2 is written. §14's heading and the registry are read accordingly.

> **Amendment, 2026-09-28 — S1 planned against the code.** Seven requirements were sharpened, none
> reversed: R1 filters at `createPodBashOps`, the one point both bash paths cross; R2 seeds a constant
> sentinel and scrubs fully only under `multi`, so a single-tenant operator key keeps working; R4 uses
> Pi's `projectTrusted: false` rather than moving `cwd`, which is also the sandbox path mapping's head;
> R5's separate listener is opt-in (`MOCA_RELAY_EXEC_ADDR`), on by default in compose and `deploy/vm`,
> with the token required everywhere; R6 excludes the worker's own settings instead of allowlisting,
> because commands need the image's own `ENV`; R7 also authorizes `/runs/status` and refuses
> asynchronous runs under `SH_REQUIRE_AUTH` until MU2; R8 keeps sandbox internet egress until S5.
> Execution added four more: R3's refusal and R4's lockdown apply at every leaf that builds
> tools or a loader (`/turn` and the `prompt` leaf through `executeTurn`, the `solve` leaf's
> `realProduceSolve`, and the default `converge` leaf's `realProduceVerdict` — every kind in
> `run-leaf.ts`'s `'converge' | 'solve' | 'prompt'`); R6 also excludes `RELAY_TLS` and
> `WORKER_MAX_CONCURRENT`; R7 refuses a caller-supplied `tenant` on an authenticated request
> (`400 tenant_not_allowed`); R8's firewall unit is required by the relay and by
> `podman-restart`, so a failed load keeps sandboxes down, and setup refuses a pre-existing
> sandbox network on another subnet.

> **The one-sentence thesis.** Multiplexing breaks Z1's "one session = one pod = one identity" at the
> worker, so everything the worker used to _assert_ — subject, bundle, workspace, placeholder — becomes
> something the trusted tier can _verify_: a short-lived grant the control plane signs, the worker
> carries but cannot mint, and every enforcement point checks.

---

## 1. Goal & motivation

P6 makes one `sh-worker` process run S in-flight turns at once, and under this design those turns may
belong to **any** users (§3, D2). Two things a turn needs are per-session rather than per-deployment:

- **Skills.** A session runs with the promoted config bundle its user chose — skills, the `CLAUDE.md`
  chain, memory. Many sessions share one bundle; a bundle belongs to a user, who may share it.
- **Credentials.** A session spends its own user's inference key and reaches external APIs (GitHub, an
  internal REST service, an MCP server) with its own user's grants. The architecture already forbids
  handing those secrets to the harness or the sandbox (ADR-0011, ADR-0012, ADR-0026): the workload
  holds an **inert placeholder** and a proxy swaps in the real value at egress.

With one session per process, "which user is this" was a property of the pod. With S sessions of
different users in one process, it is a property of **each request**, and anything the process holds
or asserts is reachable by every session in it. The goal is one property, stated so it can be tested:

> **Every use of a user's credential, bundle or sandbox state is authorized by something the trusted
> tier signed for that session; nothing a worker or a sandbox asserts can select another user's.**

Round one covers the Kubernetes-free substrate RA1 makes primary. The Kubernetes path must not
regress and keeps today's single-tenancy behaviour by default (§10); it gains no multi-user mode here.

## 2. Current state — verified, with citations

Traced on `rossoctl/main` at `8545b5e` (harness, worker, sandbox, relay, supervisor and proto code are
identical on this branch's base `ac0d859`). Line numbers are at that commit. S1 shifts some of them;
where it restructured the cited code, the symbol and its location on this branch are given too.
Designed-only items are marked as such.

### 2.1 Skills: the promotion pipeline

| Stage                           | Mechanism today                                                                                                                                                                                                                                 | Citation                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build                           | `pnpm promote` collects user/project skills, `CLAUDE.md` chain, memory, top-level commands into a canonical USTAR; digest `sha256:<hex>` over the tar minus the lockfile                                                                        | `harness/src/promote.ts:234-259`, `packages/config-bundle/src/build.ts:78-204`, `tar.ts:25-63`                                                              |
| Store                           | One Redis string per bundle, `config:bundle:<digest>`, 30-day TTL; integrity = stored bytes hash to the requested digest                                                                                                                        | `harness/src/config-store.ts:16-20`, `:52-58`, `:86-92`                                                                                                     |
| Selection                       | `configRef` on a `kind:"prompt"` run envelope only; `/turn` cannot carry one; nothing binds a bundle to an owner, session or subject, and the control plane has no bundle concept                                                               | `harness/src/run-leaf.ts:113-119`; `server.ts:132-140` (`handleTurn` types the body `{sessionId?, prompt?}` and destructures it; `:141-149` on this branch) |
| Harness side                    | Unpacked to `/tmp/sh-config/<digest>/` (skills, prompts); context kept in memory; Pi loader gets `additionalSkillPaths`, `noSkills`/`noPromptTemplates`/`noContextFiles`, `agentsFilesOverride`, `skillsOverride` (path rewrite to the sandbox) | `harness/src/config-resolver.ts:8`, `:49-84`, `:174-190`                                                                                                    |
| Sandbox side                    | Whole bundle piped as a base64 tarball into `/workspace/.sh-config/<digest>/`, refcounted per leaf under a per-pod `flock` (#216, #225)                                                                                                         | `harness/src/config-overlay.ts:10-33`, `:84-202`                                                                                                            |
| How the model reads skill files | Through the sandbox `read`/`bash` tools, at the rewritten path                                                                                                                                                                                  | `packages/k8s-sandbox/src/extension.ts:55`                                                                                                                  |

Pi already separates skills per session inside one process: the harness builds a new
`SettingsManager`, `DefaultResourceLoader` and `AgentSession` every turn
(`harness/src/run-turn.ts:711-765`: `SettingsManager.create`, `new DefaultResourceLoader`,
`createAgentSession`; on this branch `turnLoaderInputs`, `:629-658`, builds the settings manager and
loader options with R4's lockdown, and `executeTurn` constructs the loader and session at `:836-848`),
and the loader keeps skills in an instance field. Pi's loader also already exposes everything §7 needs
to load a bundle **without touching disk**: `noExtensions`, `skillsOverride`
returning in-memory `Skill` records (name, description, `filePath`, `baseDir` — no content),
`promptsOverride`, `agentsFilesOverride`
(`pi-fork/packages/coding-agent/src/core/resource-loader.ts:129-149`), and
`SettingsManager.inMemory()` (`settings-manager.ts:336`). **No `pi-fork` change is needed.**

### 2.2 Credentials: what exists in code

- **Session identity (MU1, implemented).** Ed25519 compact JWS session tokens, `aud: harness`, claims
  `sub tenant roles scope iat exp jti sid` (`packages/control-plane/src/token.ts:25-40`); the worker
  verifies with public keys only and requires `token.sid === body.sessionId`
  (`packages/knative-server/src/turn-auth.ts:199-236`). `tenant` is set to the subject — MU1 treats one
  subject as one tenant (`handlers.ts:194`).
- **Per-turn exchange (MU1, implemented).** The worker posts the session token to
  `/internal/credentials` with a shared `SH_EXCHANGE_TOKEN`; the control plane checks owner and
  tombstone and returns `{mode, anthropicAuthToken, anthropicBaseUrl}`
  (`packages/control-plane/src/exchange.ts:64-152`). `mode` is `placeholder` only when
  `SH_INJECTOR_CONFIGURED=true`, which no deployment sets, so every deployment runs **direct mode**
  (real keys in worker memory). The placeholder, when used, is `sh-placeholder-${subject}`
  (`exchange.ts:33-35`) — derivable from a subject id.
- **Credential store (MU1, implemented, Kubernetes only).** `CredentialStore` with envelope encryption
  (AES-256-GCM, KEK ring, AAD `subject|name`), consumers `inference | sandbox-egress | control-plane`,
  descriptors with `destination.hosts` and `binding {header, format}`
  (`credential-store.ts:13-103`, `envelope.ts`); only `K8sSecretStore` exists. `sandbox-egress`
  credentials are stored but **never delivered** — no code path consumes them. A Kubernetes-free store
  is #348's item 2.
- **Placeholder swap (RC1, implemented, single-tenant).** AuthBridge `static-inject` selects the real
  credential by destination host or a static key, never by caller (`deploy/knative/authbridge/`).
- **Designed only.** P5's scrub and sentinel; Z5's `(subject ⊕ destination)` resolution; Z1's per-session
  SPIFFE identity; P4.1's vsock egress hop and socket-path caller identity (`remote-worker` has nothing
  on ports 1025/3128; only the E12 probe exists).

### 2.3 The sandbox tiers

- **Container tier.** `remote-worker` runs every command as `bash -c` in one container, under one UID,
  network namespace and `/workspace`, shared by up to `KAGENTI_SANDBOX_CAP` lease holders
  (`remote-worker/internal/exec/runner.go:189`; `harness/src/sandbox-lease.ts`). The relay records a
  sandbox's pool labels **as the sandbox reports them** in its `Hello` (`packages/sandbox-relay/src/relay.ts:73-74`),
  so no partition keyed on those labels can be trusted. `deploy/vm` runs sandboxes under rootful podman
  with default capabilities and reaches the relay through `host-gateway` (`deploy/vm/setup-vm.sh:256-283`);
  Redis is correctly bound to loopback (`:160-161`). `deploy/compose` puts every service on one network.
- **MicroVM tier.** One Firecracker VM per `Exec`, restored from a golden snapshot in its own jailer
  chroot; pools are per workspace key (`remote-worker/internal/vmpool/runpool.go:16`,
  `pool.go:388-580`). `Exec.workspace_key` is the session id on the `/turn` path
  (`harness/src/select-sandbox.ts:386-396`) and is asserted by the harness; nothing on the wire carries
  a subject (`proto/sandbox/v1/sandbox.proto:49-69`).

### 2.4 Cortex (formerly AuthBridge) as of `403d5d2`, 2026-09-28

Evaluated as the credential-injecting proxy (P4.1 §12.2's presumptive answer). It runs as a plain host
process under systemd and implements TLS interception (`tls_bridge`), config hot-reload, and
bearer-keyed per-caller resolution (`token-exchange`, RFC 8693, with a result cache; `token-broker`).
It does **not** today: select a credential by a verified caller identity (no plugin reads
`pctx.Identity`; session headers are client-asserted by design, cortex#984); carry an identity from a
CONNECT into the requests bridged inside that tunnel; listen on anything but TCP; or record an audit
event on a successful injection. Per-subject resolution (cortex#905) has no PRs. Consequently an
**unmodified** Cortex can give per-user egress only by putting a replayable bearer inside the guest,
which a prompt injection can exfiltrate and replay from another user's VM on the same host. That
finding, plus the dependency it would create on another repository's roadmap, is why §8 builds
`moca-egress` and keeps Cortex as a later, conformance-gated replacement (D4, §14). cortex#905 has
been rescoped accordingly. This reading holds for Cortex at `403d5d2` and no earlier; it is a dated
capability survey, not a conformance result. Adoption (S6) re-runs §12.3's suite against the specific
Cortex release proposed, and nothing here is inherited as a pass.

### 2.5 What this implies

1. Skills are already separated per session **in memory**; what is missing is **authorization** (who may
   use a bundle), **integrity of the binding** (a bundle chosen by the trusted tier, not the request),
   and removal of the **shared on-disk state** on both sides.
2. Credentials have a store and an exchange, but no component can tell users apart **at egress**, and
   the inference path hands real keys to the worker.
3. The sandbox tier asserts nothing trustworthy about which session or user a command belongs to.

## 3. Resolved scope decisions

Settled with the project owner before this document was written; each is load-bearing for a later
section.

| #   | Question                                        | Decision                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Target substrate                                | RA1's primary: P6 supervisor + workers, with **both** the container tier (compose, `deploy/vm`) and the P4 microVM tier. The Kubernetes path must not regress; it gets no multi-user mode here                                                                   |
| D2  | Which boundary may one worker cross             | **Any users.** A worker may hold sessions of different users at once. The cost — a worker compromise exposes its in-flight sessions — is bounded by grant lifetime and stated (§4.3), not hidden                                                                 |
| D3  | Who may attach a bundle                         | **Owner + explicit shares** to named users. Sharing to an organization waits for `tenant` to mean a group (MU1 §11 item 1)                                                                                                                                       |
| D4  | Which proxy swaps placeholders                  | **`moca-egress`**, a single-purpose Go proxy in this repo, implementing a connection-bound identity contract. Cortex replaces it only when it passes the same conformance suite **and** MOCA needs a Cortex-only capability (IBAC, SPARC, OPA, budgets, `abctl`) |
| D5  | Who mints grants                                | **The control plane**, extended. No external authorization server. Keycloak or another OIDC provider is a later option for login, for minting tokens for OAuth backends behind the token endpoint, or for separation of duties if a review requires it           |
| D6  | Container-tier isolation unit                   | **One sandbox container belongs to one user**, bound statically in relay-side configuration (option B). A launcher that creates and recycles per-user containers is deferred                                                                                     |
| D7  | Credential shape inside a sandbox               | The **constant, image-shipped placeholder** of P4.1 T5. No per-session secret — a grant, a bearer, a real credential — ever enters a guest                                                                                                                       |
| D8  | Direct mode (real inference keys in the worker) | Allowed only under `MOCA_TENANCY=single`, where the control plane **pins the first subject** that creates a session and refuses any other. Refused under `multi`                                                                                                 |

## 4. Trust model

### 4.1 Tiers on one MOCA host

| Tier          | Components                               | Trust                                                                                           | Holds                                                                                                                                                                               |
| ------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Control**   | control plane, `moca-egress`             | trusted; not model-influenced                                                                   | control plane: session-token and grant signing keys, credential KEK, credential store, bundle ACLs. `moca-egress`: real credentials in a short-lived cache, the interception CA key |
| **Host glue** | sandbox relay, `microvm-worker`/`vmpool` | trusted; not model-influenced. `microvm-worker` is privileged (KVM) and holds **no** credential | routing; which VM or container belongs to which session's grant                                                                                                                     |
| **Brain**     | supervisor, `sh-worker` × W              | semi-trusted — processes untrusted data (model output, tool results)                            | grants for its in-flight sessions; no signing key, no credential in `multi` mode                                                                                                    |
| **Hands**     | microVM guests, sandbox containers       | untrusted — runs model-authored code                                                            | constant placeholders, the interception CA's public certificate, its own session's workspace and bundle copy                                                                        |

`moca-egress` is control tier because it is the only process that ever holds a real credential. It
runs as its own Unix user. Workers reach only its inference listener; guests reach only their own
egress socket.

### 4.2 Invariants

Each is enforced at a named point and will be pinned by a named test (§12) when the slice that
enforces it lands. What S1 already enforces is pinned by the tests in §5's "Pinned by" column.

| #      | Invariant                                                                                                                                                                                                                                                          | Enforced by                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **I1** | **No real credential in the brain or the hands.** In `multi` mode no provider or egress credential is in worker memory or environment, and sandboxes never receive the worker's environment                                                                        | env allowlist (§5), P5 scrub, direct mode refused (§6.6)       |
| **I2** | **Only a grant confers authority.** Every credential use, bundle load and sandbox binding is authorized by a control-plane-signed grant; the brain presents only grants it was given and cannot mint them                                                          | Ed25519 signatures; public keys only outside the control plane |
| **I3** | **Caller identity comes from the connection, never the request.** A VM is known by the socket that accepted it, a container by its source address on a dedicated network, a worker by the inference grant it presents; the inner `Host` must equal the dial target | `moca-egress` (§8)                                             |
| **I4** | **Credentials are bound to destinations.** A credential is injected only for a host in its `destination.hosts`, only on a connection dialed to that host; the placeholder is always overwritten; an off-allowlist destination is refused with a named error        | `moca-egress` + the credential descriptor                      |
| **I5** | **Fail closed at every step.** No grant: no turn. No sandbox: no tools. No credential: `401` and no upstream request. Unverifiable bundle: the turn fails                                                                                                          | every enforcement point                                        |
| **I6** | **Bundles are data to the brain.** Only skills, prompts and context from an ACL-authorized, verified digest are loaded; Pi extensions, settings and `SYSTEM.md` are never loaded from a bundle or a shared directory                                               | loader options, layout allowlist at load (§7)                  |
| **I7** | **Sandbox state is session-scoped** (microVM tier) **or subject-scoped** (container tier). No other session's or user's workspace or bundle copy is visible                                                                                                        | `vmpool` grant binding (§8.2); relay owner binding (§9.2)      |
| **I8** | **Minimal reachability.** Sandboxes reach only the relay's `Attach` listener and `moca-egress`; workers reach relay `Exec`, Redis, the control plane and `moca-egress`'s inference listener; each `/internal` endpoint accepts exactly one caller credential       | listener split, network segmentation (§9)                      |

### 4.3 Blast radius, stated for review

| Compromised                                 | Reaches                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A sandbox** (the normal case: model code) | Its own session's workspace and bundle copy (its own user's, on the container tier); **use**, never read, of its own user's credentials, for allowlisted destinations only                                                                                                                                              |
| **One worker**                              | The grants of the ≤ S sessions it is running, usable until they expire (≤ `MOCA_GRANT_TTL_S`); read of Redis (sessions, bundles) — **pre-existing**, identical to any harness process today. It cannot mint grants or read credentials. Multiplexing grows this from one session to S sessions; that is the price of D2 |
| **`moca-egress`**                           | The credentials in its cache, and credentials for grants currently bound on that host. **No standing access** to the credential store: it can only redeem grants that are presented to it                                                                                                                               |
| **The control plane**                       | Everything. It is the crown jewel, as Z1 §9 and MU1 §3.3 already record                                                                                                                                                                                                                                                 |

**One gap this design does not yet close: caller-named volumes.** `POST /workloads` forwards
`workspace.claimName` to Context Service, and neither the harness nor Context Service checks that the
caller may use that PVC. S1 binds a workload to the subject that created it (R7), but owning the
workload says nothing about owning the volume it names. On the Kubernetes path a user could otherwise
create a workload over another user's claim and run on it. So a `claimName` is refused
(`400 claim_name_not_allowed`) from any authenticated caller, which under `SH_REQUIRE_AUTH=true` is
every caller, and always under `MOCA_TENANCY=multi`. Such a workload gets only the volume Context
Service provisions for it. Scoping claims per subject is deferred (§13). Workload names also remain
one namespace across subjects, first come, first served.

## 5. Slice S1 — worker and sandbox-tier hardening (prerequisites)

S1 hardens the worker and sandbox tiers as they stand, independently of grants, and every later slice
assumes it. Its requirements apply in **both** tenancy modes: each is a hardening, not a feature. This
section states the required behaviour and the test that pins it.

| #   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Pinned by                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The sandbox receives an **explicit environment allowlist** (`LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`), never the worker's process environment. It is applied in `createPodBashOps`, which both the `bash` tool and the `user_bash` hook reach — no `pi-fork` change                                                                                                                                                                                                                                                                                                                                                                         | a planted secret-shaped variable never appears in any `Exec.command`, through the real bash tool — `packages/k8s-sandbox/test/extension.test.ts`; the allowlist prefix built by `createPodBashOps`, `test/operations.test.ts`; the allowlist itself, `test/sandbox-env.test.ts`                                                                                                                                                                                                   |
| R2  | `applyModelGateway` seeds `ANTHROPIC_API_KEY` only with the constant sentinel, never a caller's token. A shared `prepareServerProcess()` runs in `startServer()`, the P6 worker and the async-run job (`leaf-job.ts`); under `multi` it deletes every provider credential pi can read from the environment (any `*_API_KEY`, `*_AUTH_TOKEN` or `*_OAUTH_TOKEN`, `HF_TOKEN`, `COPILOT_GITHUB_TOKEN`, Bedrock's `AWS_*` sources and `GOOGLE_APPLICATION_CREDENTIALS`), leaving only the sentinel, and refuses `SH_LOCAL_TOOLS=1` and `SH_REQUIRE_AUTH` other than `true`. Under `single` an operator's own ambient key is left in place | a token-less call after an authenticated one sees only the sentinel, and a caller credential on a non-Anthropic model throws — `harness/test/model-gateway.test.ts`; the multi scrub deletes the OAuth token, which outranks the sentinel, `single` keeps an operator key, and `multi` refuses both settings — `packages/knative-server/test/server-process.test.ts`; all three entry points call `prepareServerProcess` — `test/worker-boot.test.ts`                             |
| R3  | In server and worker mode, a turn with **no resolvable sandbox fails** rather than running tools in the worker. Local tools remain only in the CLI (`harness/src/cli.ts`), or behind an explicit `SH_LOCAL_TOOLS=1` that `multi` refuses                                                                                                                                                                                                                                                                                                                                                                                              | no sandbox → the turn fails before an agent session (and so any tool) is built — `harness/test/turn-require-sandbox.test.ts`; the guard, `assertServerSandbox`, in `test/select-sandbox.test.ts`; the solve and verdict leaves in `test/run-leaf.test.ts`; every server turn marked `serverMode`, `packages/knative-server/test/server-process.test.ts`                                                                                                                           |
| R4  | In server and worker mode: `noExtensions: true`, `noContextFiles: true`, `noSkills: true`, `noPromptTemplates: true`, `noThemes: true` (a promoted bundle still delivers its skills and prompt templates through its own paths), the project untrusted (`projectTrusted: false`, so no project settings, `SYSTEM.md` or `APPEND_SYSTEM.md`), and `PI_CODING_AGENT_DIR` pointed at a fresh private per-process directory                                                                                                                                                                                                               | planted project `SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md`, extension file, `$HOME/.agents/skills` skill and agent-directory prompt template are not loaded by the real Pi loader, and are loaded outside server mode; a promoted bundle's skills still load — `harness/test/loader-lockdown.test.ts`; the same options on the solve and verdict leaves, `test/run-leaf.test.ts`; the private 0700 `PI_CODING_AGENT_DIR`, `packages/knative-server/test/server-process.test.ts` |
| R5  | `SandboxExec` and `Abort` require a worker credential (`MOCA_RELAY_EXEC_TOKEN`), distinct from every sandbox token, on every deployment; the relay refuses to boot without it. `MOCA_RELAY_EXEC_ADDR` serves `SandboxExec` on its own listener (compose: the relay's brain-network address; `deploy/vm`: loopback)                                                                                                                                                                                                                                                                                                                    | an Exec or Abort without the token is refused, the relay refuses to boot without it or with one equal to a sandbox token, and on a split relay the attach listener does not serve Exec — `packages/sandbox-relay/test/exec-auth.transport.test.ts`, `test/split-listeners.transport.test.ts`; the worker sends it, `harness/test/relay-exec-client.test.ts`, `harness/test/select-sandbox.test.ts`, `remote-worker/cmd/exec-driver/drive_test.go`                                 |
| R6  | `remote-worker` runs commands with an **explicit `cmd.Env`**: the container's environment minus the worker's own settings (`SANDBOX_TOKEN`, `RELAY_ADDR`, `SANDBOX_ID`, `SANDBOX_IMAGE`, `SANDBOX_TRUST`, `RELAY_TLS`, `WORKER_MAX_CONCURRENT`, `SANDBOX_TOKEN_*`, `SH_*`, `MOCA_*`)                                                                                                                                                                                                                                                                                                                                                  | a grandchild of a command sees none of them, and still sees the image's own environment — `remote-worker/internal/exec/runner_test.go` (`TestCommandsDoNotInheritWorkerSettings`, which plants every name); `sandboxenv_internal_test.go` (`TestEveryWorkerSettingIsExcluded`: every setting `cmd/worker/main.go` reads is excluded)                                                                                                                                              |
| R7  | Under `SH_REQUIRE_AUTH=true`, `POST /runs` and `/v1/runs` require a session token naming the run's session and execute on the exchanged credential; `GET /runs/status` is authorized by session; asynchronous runs are refused (`501`) until MU2's owned runs; a caller-supplied `tenant` on an authenticated request is refused                                                                                                                                                                                                                                                                                                      | no token → `401`; another session's token → `400 session_mismatch`; async → `501`; authenticated request with `tenant` → `400 tenant_not_allowed`, on `/runs`, `/v1/runs` and `/runs/status` — `packages/knative-server/test/runs-auth-route.test.ts`, `test/turn-auth.test.ts`; `/workloads` owned by the creating subject — `test/workload-auth-route.test.ts`                                                                                                                  |
| R8  | Compose puts sandboxes on `moca-sandbox` and Redis and the supervisor on `moca-brain`, with only the relay on both. `deploy/vm` runs sandboxes on a dedicated podman network, isolated from every other podman network (`isolate=strict`), whose traffic to the host is dropped, in every address family, except the relay's attach port and DNS. Outbound internet is unchanged until S5                                                                                                                                                                                                                                             | the compose topology test — `deploy/compose/tests/compose.test.sh`; the sandbox network created with `isolate=strict` and a pinned bridge name, and setup refusing a network that does not report both or sits on another subnet; the table matching that bridge, so IPv6 is dropped too; the nftables table rendered and loaded by a oneshot unit ordered before, and required by, the relay and `podman-restart` — `deploy/vm/tests/setup-vm.test.sh`                           |

R6 is honest about its limit: commands still run as the same Unix user as `remote-worker`, so its
token remains readable through `/proc`. §9.2's per-sandbox tokens are what make that exposure cross no
user boundary; separating the Unix users is optional hardening (§13).

## 6. Slice S2 — session grants and the token endpoint

### 6.1 Two grants per turn

Each grant is valid at a different enforcement point, and neither substitutes for the other.

|              | **Inference grant**                               | **Sandbox grant**                                                                          |
| ------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `aud`        | `moca-inference`                                  | `moca-sandbox`                                                                             |
| Held by      | the worker                                        | the worker; sent with every `Exec`; bound to the VM or container by host glue              |
| Presented to | `moca-egress`'s inference listener, as the bearer | `moca-egress`'s egress listener, **through the connection binding** — never inside a guest |
| Verified by  | `moca-egress`, the token endpoint                 | `microvm-worker`, the relay (container tier), `moca-egress`, the token endpoint            |
| Claims       | `iss sub tenant sid cred iat exp jti turn_exp`    | `iss sub tenant sid cfg egress iat exp jti turn_exp`                                       |

- `cred` names the session's inference credential (MU1 §6.4's per-session choice).
- `egress` is the list of `sandbox-egress` credential names the session may use.
- `cfg` is the bundle digest bound to the session (§7.2), absent when none is.
- `turn_exp` is an absolute cap: turn start + `MOCA_TURN_MAX_S`.
- `exp = min(now + MOCA_GRANT_TTL_S, turn_exp)`.

**Format and keys.** The compact Ed25519 JWS of `token.ts`, generalized over `typ` and `aud`, with a
**separate key ring** (`kid`, newest first, as for session tokens) and header `typ: moca-grant+jwt`, so
a session token can never pass as a grant even where an `aud` check is forgotten. `alg` is pinned to
`EdDSA`; `alg: none`, an unknown `kid`, or a `typ`/`aud` mismatch is refused. Only the control plane
holds the signing key. `moca-egress`, `microvm-worker` and the relay receive public keys
(`MOCA_GRANT_PUBLIC_KEYS`, `kid:base64-DER`). Workers need no grant keys: they receive grants over the
authenticated exchange and never verify them.

**Why the control plane, and nothing new (D5).** Deciding to issue a grant needs session ownership,
the tombstone, the session's credential and bundle bindings and the turn deadline — all of which live
in the control plane already. An external authorization server would call back for every one of them.
The control plane already signs session tokens with the same primitive; the change is a second key
ring and three endpoints, not a subsystem. Its single-signer role is unchanged from MU1, which makes
protecting its keys the first operational requirement (§6.7).

### 6.2 Lifecycle

```
turn start  worker ── session token + SH_EXCHANGE_TOKEN ──▶ POST /internal/turn-grants
            ◀── { inferenceGrant, sandboxGrant, inferenceUrl, cfg }
mid-turn    worker ── current grant + SH_EXCHANGE_TOKEN ──▶ POST /internal/grants/refresh
            ◀── same claims, new exp  (refused past turn_exp or once the session is tombstoned)
each Exec   sandboxGrant rides on Exec.grant; host glue keeps the newest verified grant per session
```

`/internal/turn-grants` replaces `/internal/credentials` (MU1 §5.3); `inferenceUrl` is `moca-egress`'s
inference listener, so the worker never chooses where a credential is sent. The worker refreshes at
half-life. The short lifetime is what bounds revocation latency (a deleted session or credential stops
working within `MOCA_GRANT_TTL_S`), the replay window of a stolen grant, and — through `turn_exp` — the
longest a turn may run on one exchange. **No revocation list is built**; short lifetimes do that job
(§13).

### 6.3 The token endpoint (RFC 8693-shaped)

```
POST /internal/token                           client auth: moca-egress's OWN credential
  grant_type=urn:ietf:params:oauth:grant-type:token-exchange
  subject_token=<grant>   subject_token_type=urn:moca:token-type:session-grant
  audience=inference | <destination host>
→ 200 { access_token, issued_token_type, token_type, expires_in,
        moca_binding: { header, format } }
```

The shape is RFC 8693 so that Cortex's `token-exchange` plugin can call it unchanged if Cortex later
replaces `moca-egress` (D4). `moca_binding` carries the credential descriptor's `binding`, which is
non-secret metadata; a client that ignores it injects `Authorization: Bearer`.

**Only `moca-egress` can call it**, with `MOCA_EGRESS_CP_TOKEN`, distinct from the workers'
`SH_EXCHANGE_TOKEN`. A compromised worker therefore holds grants but **cannot turn them into
credentials** — I1 enforced in the trusted tier rather than by the worker's good behaviour. Each
`/internal` endpoint accepts exactly one caller credential and refuses the other.

**Checks, in order, each failing closed with a named code:**

1. Signature, `typ`, `aud`, `exp` and `turn_exp` (`grant_invalid`).
2. The session exists, is not tombstoned, and its owner equals the grant's `sub` (`session_not_found`).
3. For `audience=inference`: the inference credential recorded on the **session** (the grant's `cred`
   must name it; the session record, not the grant, is authoritative), resolved as MU1 §5.3 does today,
   including `endpoint_unresolved` and the audited operator fallback. For a host: the credentials named in
   `egress` whose `consumer` is `sandbox-egress` and whose `destination.hosts` matches the host.
4. More than one match → `credential_ambiguous`; none → `no_credential`. `moca-egress` answers the
   guest `401` and sends nothing upstream.
5. An audit event to `sh:cp:audit`: subject, sid, credential name, audience, caller `moca-egress`.

`expires_in` is at most `MOCA_TOKEN_TTL_S` (60 s), so rotating or deleting a credential takes effect
within a minute. `moca-egress` caches per (sid, credential) for `min(expires_in, grant exp)`.

### 6.4 The inference path

`applyModelGateway`'s tagged credential (`harness/src/run-turn.ts`, MU1 §3.6 item 1) gains a third
mode, `grant`: the worker sends `Authorization: Bearer <inference grant>` to `inferenceUrl`, and
`moca-egress` swaps it (§8.6). Two existing gaps close inside this slice:

- `applyModelGateway` handles only `anthropic-messages`; an absent `api` is read as that default, and
  any other value, the empty string included, is non-Anthropic (`run-turn.ts:511-522`). A non-Anthropic
  model is returned untouched when no caller credential is in play, so an OpenAI-compatible model still
  uses an ambient `OPENAI_API_KEY`; with a per-caller credential present the call **throws** rather than
  drop it for the shared operator key. S2 must install the grant header for every model API the worker
  supports, which retires the throw.
- The worker keeps P5's sentinel so Pi's by-provider-name existence check passes (P5 §3.3); the sentinel
  carries no identity and is stripped at `moca-egress`.

### 6.5 Leaves

Synchronous `/runs` authenticates (R7) and receives grants exactly as `/turn` does. Asynchronous and
scheduled leaves are MU2's to build, under one requirement stated here: **no bearer token is ever
stored in the work queue.** The control plane mints a leaf's grants when a worker takes it off the
queue, from a run record the control plane owns, created by the authenticated enqueue.

### 6.6 Tenancy and direct mode

`MOCA_TENANCY=single|multi` is read by every component (§10). Direct mode — the control plane
returning a real inference key to the worker — is reachable **only** under `single`, where the control
plane **pins the first subject** that creates a session (`SET NX` on `sh:cp:tenancy:subject`) and
refuses any other with `403 single_tenant_deployment`. That keeps a one-person trial (#348) working
with direct mode and the operator fallback, without anyone configuring a subject id in advance. The pin
lives in the same Redis as the sessions it protects, so anything that clears it also clears every
session it guarded; it is not a security boundary against someone who can already write that Redis.
Under `multi`, the exchange returns grants or refuses; it never returns a real key.

The pin changes what `single` serves. Before S2, `deploy/vm` leaves `MOCA_TENANCY` unset and serves
any subject that logs in, which is what the two-user VM runbooks (`docs/demos/vm-two-user-acceptance.md`,
`docs/demos/vm-multi-user-demo.md`) rely on. From S2, the same deployment serves its first subject and
refuses the second. `multi` is not the way around it until S5: on the container tier, every user's
turns share the same sandbox containers, and `multi` would claim they do not (§9.1). So the two-user
demo is sequenced (#407):

- **Until S5,** it runs against `v0.5.1`, the last tag before S2, under `single` with no pin.
- **From S5,** it runs on `main` under `MOCA_TENANCY=multi`, with one owned sandbox per user.

S2 does not add a refusal to `setup-vm.sh`. The script cannot tell a two-user posture from a
one-user one, since anyone with a GitHub account can log in through the same OAuth app. The control
plane's `403 single_tenant_deployment` is the refusal. Its message does not offer `multi` as the
fix: between S2 and S5, `multi` on the container tier is the posture this section calls not honest,
and nothing refuses it at startup until S5's owner-binding checks (§10.1, the relay row). So the
message says that serving a second user needs `MOCA_TENANCY=multi` **with** one owned sandbox per
user, which on the container tier is S5, and points to this section.

### 6.7 Key custody

On `deploy/vm`, signing keys, the KEK and every shared token reach their processes as files through
systemd `LoadCredential=`; in compose, as `secrets:` files (mode 0600) — **never as environment
variables**, which `docker inspect`, `/proc/<pid>/environ` and child processes can all see. The
control plane runs as its own Unix user. `install.sh` generates the grant key ring next to the
session-token keys #348 adds, and `moca-egress`'s client credential and the relay exec token next to
them.

## 7. Slice S3 — skills and config bundles

### 7.1 Ownership and sharing live in the control plane

- **Promotion uploads through the control plane.** `pnpm promote` gains `--control-plane-url` and
  authenticates with the user's API token; `PUT /v1/bundles/{digest}` takes the gzipped canonical tar.
  The control plane **re-runs the checks a client cannot be trusted to have run**: the digest matches
  the content, the layout is on the allowlist (§7.3), the structural secret-scan rules pass
  (`packages/config-bundle/src/secret-scan.ts`), and the size caps hold. It records `owner = token.sub`.
  Direct `--redis-url` upload remains for `single` tenancy only.
- **The blob store stays content-addressed** (`config:bundle:<digest>`), with an ACL record beside it
  (`sh:cp:bundle:<digest>` → owners, shares) and a per-subject index for listing. Two users promoting
  identical content store one blob and both become owners; possessing the content is the proof, so
  neither gains anything it did not already have.
- **Sharing:** `POST /v1/bundles/{digest}/shares {subject}` and `DELETE …/shares/{subject}`, by an
  owner. `GET /v1/bundles` lists what a caller owns or has been shared, metadata only. Because a bundle
  carries `CLAUDE.md` and memory, the share response names the context and memory files it exposes.
- **The lockfile stops recording absolute laptop paths** (`packages/config-bundle/src/lockfile.ts:28`
  records `sourceDir`, which discloses a username into shared Redis and the sandbox); it records paths
  relative to the scope root instead.
- **Integrity without signatures.** A blob planted under digest X must still hash to X, and only the
  control plane can place X in a grant, so a principal with Redis write access can neither substitute
  content nor introduce a new bundle into any session.

### 7.2 A session is bound to its bundle at creation

- `POST /v1/sessions {credentials, configRef}` checks `sub ∈ owners(configRef) ∪ shares(configRef)` and
  stores `cfg` in the session record. The binding is **immutable** for the session's life: new skills
  mean re-promoting and starting a new session, which keeps a session's log reproducible from one
  config. A `PATCH` to rebind is possible later and deliberately not built (§13).
- `cfg` reaches the worker **only inside the sandbox grant**. `/turn` gains bundle support, which today
  only `/runs` prompt leaves have.
- Under `SH_REQUIRE_AUTH=true`, a `configRef` in a request body is rejected with `400 configRef_forbidden`.
  `single`-tenancy `/runs` keeps accepting it, and still verifies the digest.

### 7.3 Loading in the worker: data only, in memory

1. Fetch `config:bundle:<cfg>`; verify its sha256; enforce `MOCA_BUNDLE_MAX_BYTES` (8 MiB compressed)
   before decompressing, and bound decompression itself — total uncompressed bytes, entry count and
   per-entry size — so a compression bomb aborts rather than exhausting memory (today's
   `gunzipSync` has no output limit, `harness/src/config-store.ts:81`).
2. **Layout allowlist:** `skills/**`, `prompts/*.md`, `context/**`, `memory/*.md`, `prompt/*.md`,
   `lockfile.json`, regular files only. Anything else refuses the bundle — `extensions/`,
   `settings.json`, `SYSTEM.md`, a symlink, a `..` segment, an absolute path. The bundle format version
   is checked, as the promotion design required and the code never did.
3. Parse into an immutable, deep-frozen **`ResourceSet`** per digest: skill metadata from each
   `SKILL.md`'s frontmatter (safe YAML parse), prompt templates, context strings. It is cached per
   worker, LRU by bytes (`MOCA_BUNDLE_CACHE_BYTES`), with a reference count of the turns using it.
   **Nothing is unpacked to disk**, which retires the shared `/tmp/sh-config`.
4. In server and worker mode the loader options are fixed, not configurable: `noExtensions`,
   `noSkills`, `noPromptTemplates`, `noContextFiles`; `skillsOverride`, `promptsOverride` and
   `agentsFilesOverride` supplied from the `ResourceSet`; `SettingsManager.inMemory()`;
   the project untrusted and `PI_CODING_AGENT_DIR` private, as R4 sets them, so no `SYSTEM.md` or
   `APPEND_SYSTEM.md` is discovered. The test asserts the assembled system prompt equals the one an
   empty agent directory produces, plus the bundle's own fragments.
5. Each `Skill`'s `filePath`/`baseDir` names **that session's** sandbox path (§7.4). `/skill:<name>`
   expansion reads `skill.filePath` from the worker's disk
   (`pi-fork/packages/coding-agent/src/core/agent-session.ts:1184`), so it is disabled in server mode
   and a test pins that; no harness path reaches it today.

**Why the worker reads the bundle at all.** Pi lists available skills and inlines context in the system
prompt, so the brain needs the prompt-facing parts; without them the model would not know the skills
exist. The alternative — fetching those parts from the sandbox copy — would make the untrusted tier
the source of the brain's system prompt, and a guest can edit its copy, so one prompt injection could
rewrite the instructions of every later turn of that session. Reading from the verified blob ties the
system prompt to exactly what the user promoted. **The sandbox copy is data the model reads, never
instructions the worker trusts.**

### 7.4 Delivering the bundle into the sandbox

**v1 reuses the existing push, per session.** Once per session, the worker pushes the verified bundle
into `<session workspace>/.moca-config/` through the existing overlay path, and records the digest in
a marker file so later turns skip the push. In `multi` mode the shared `/workspace/.sh-config` cache and
its refcounts (#225) are **not used** — they are state shared across subjects. On the microVM tier the
workspace is already per session (`workspace_key` = session id); on the container tier the container is
per subject (§9), so only the same user's sessions share it. A guest may edit its own copy; that
affects only its own session. `MOCA_BUNDLE_MAX_BYTES` keeps the base64 push under the relay's 16 MiB
message cap (`packages/k8s-sandbox/src/transport.ts:146`), and an oversized bundle fails at promote
time, not at run time. The injected "Skill files:" line names the session path.

**v2, an optimization only (§13):** `vmpool` materializes the bundle host-side from the sandbox grant's
`cfg`, once per digest, and mounts it **read-only** into the jail. It saves the per-session push but needs
a second drive in the Firecracker snapshot. Deferred until the push cost is measured.

## 8. Slice S4 — `moca-egress` and egress on the microVM tier

This slice is P4.1's implementation (#277), with its §12.2 proxy decision taken (D4) and one gap in
its identity model closed: P4.1 knew **which VM** was calling, but nothing trustworthy said **which
session and user** that VM served (#278). The sandbox grant is that link.

### 8.1 Processes

| Process          | Language | Runs as                        | Holds                                                                              |
| ---------------- | -------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| `microvm-worker` | Go       | privileged (KVM, jailer)       | `vmpool`; grant public keys; no credential                                         |
| `moca-egress`    | Go       | its own unprivileged Unix user | interception CA key; cached credentials; grant public keys; `MOCA_EGRESS_CP_TOKEN` |

`moca-egress` is deliberately a separate process: the component that can spawn VMMs must not also hold
credentials. It lives at `remote-worker/cmd/moca-egress` with policy in `remote-worker/internal/egress`,
beside the `vmpool` it pairs with.

### 8.2 `microvm-worker` binds pools to grants

- **Wire change, additive:** `Exec` gains `bytes grant = 7` (`proto/sandbox/v1/sandbox.proto`),
  carrying the sandbox grant. The container `remote-worker` ignores it; the relay reads it on the
  container tier (§9.2).
- Under `MOCA_TENANCY=multi`, `microvm-worker` **refuses** an `Exec` whose grant is missing, invalid or
  expired, with a counted `ExecError`. The workspace is derived from the grant — `WorkspaceRoot/<grant.sid>`
  — and the request's `workspace_key` must equal it; a run pool is pinned to one `sid`, and an `Exec`
  carrying another session's grant is refused.
- Consequence worth stating: even a caller that reaches relay `SandboxExec` without authority cannot run
  a command in any VM workspace **without a live grant for that session**. This holds independently of
  R5 and is kept for defense in depth.

### 8.3 Who owns the per-VM egress socket

A guest's egress arrives on `<jail>/run/v.sock_1025`, which the host must be listening on before the
guest connects (P4.1 §6). **`vmpool` creates the listening socket at replenishment and passes the
listening file descriptor to `moca-egress`** with `SCM_RIGHTS`, over a control socket
(`/run/moca-egress/control.sock`, mode 0600) on which `moca-egress` admits only the configured
`microvm-worker` and relay Unix users (`SO_PEERCRED`).

- `moca-egress` never touches the root-owned jail directories, so it stays unprivileged.
- **The file descriptor is the identity.** `moca-egress` knows which VM a connection came from by which
  descriptor accepted it; nothing a guest sends can change that. This is P4.1 T4's socket-path identity,
  realised without giving the proxy filesystem access to jails.

Control messages, length-prefixed protobuf (`proto/egress/v1/control.proto`):

| Message                                  | Sent when                                                                 | Effect                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Register{vm_id, sid, grant, listen_fd}` | a standby is replenished for a session's pool                             | `moca-egress` verifies the grant (signature, `aud=moca-sandbox`, `exp`, `sid`) and binds vm → sid |
| `Rebind{sid, grant}`                     | an `Exec` carries a newer grant (refresh)                                 | replaces the session's current grant; all its VMs use it                                          |
| `Unregister{vm_id}`                      | teardown — **after** SIGKILL, **before** the socket is unlinked (P4.1 §6) | drops the binding; in-flight requests end with a counted error                                    |

If `moca-egress` restarts, `vmpool` re-sends `Register` for every live VM on reconnect.

The control connection is shared by every VM on the host, so losing it unbinds them all — and an
unbind ends a VM's in-flight requests. A control call that gives up on its own deadline therefore
**keeps the connection**: its reply is still owed, the client discards exactly that one, and the
stream comes back into step, so one slow call costs only itself rather than aborting every other
VM's in-flight requests. Because `moca-egress` binds a VM before it verifies the grant, a `Register`
abandoned that way may still have taken effect; the client sends a compensating `Unregister` in the
background, so `moca-egress` converges on the client's view either way.

### 8.4 Guest side: P4.1, unchanged

`HTTPS_PROXY=http://127.0.0.1:3128` → the guest agent splices to vsock port 1025 (P4.1 T1/T2). One
constant placeholder, `moca-placeholder`, ships in the image under the conventional variable names
(`GH_TOKEN`, `GITHUB_TOKEN`, …), and a system git credential helper returns it (D7, P4.1 T5). The CA's
public certificate is in the rootfs (T6). No network device, no DNS. Nothing unique or secret enters
the snapshot (P4 §5.2).

### 8.5 Egress policy, per connection and per request

1. **Identity.** Accepting descriptor → vm → sid → current grant. No binding, or an expired grant →
   `403 grant_expired`. The proxy never asks the guest who it is.
2. **Caps.** A per-VM concurrent-connection cap (`MOCA_EGRESS_MAX_CONNS_PER_VM`, P4.1 §8's
   descriptor-exhaustion row) and Z5's hard per-session request cap
   (`MOCA_EGRESS_MAX_REQUESTS_PER_SESSION`) → `429`. A slot is also bounded in **time**: an
   established connection on which no byte moves for `MOCA_EGRESS_IDLE_TIMEOUT_S` is closed, on both
   the tunnel and the forward path and in either direction, and a forwarded request waits at most
   `MOCA_EGRESS_RESPONSE_HEADER_TIMEOUT_S` for its response headers before the existing
   `502 upstream_unreachable`. The idle bound is refreshed on every byte, so a transfer of any
   duration survives and only a silent connection expires. Without it a count-only cap is unbounded
   in time: one guest could hold all 32 of its slots, and an upstream socket each in a process every
   VM shares, for the VM's lifetime. An expiry is an ordinary end of connection — no new audit
   decision value, and the `tunnel` event still carries its byte counts.

   The bound is on the **connection**, not on one socket's one direction: a byte on either leg pushes
   out both legs' deadlines, because traffic is routinely one-way for long stretches and a per-leg
   bound would expire mid-transfer on a healthy `git clone`. Which deadlines a byte vouches for is
   per path — a tunnel is opaque, so any byte keeps the whole of it alive, while the forward path
   knows the directions apart and keeps them honest: relaying a response proves the guest is
   _reading_, which must not excuse a request body it promised and never sent.
   `MOCA_EGRESS_RESPONSE_HEADER_TIMEOUT_S` defaults to the idle bound rather than tighter, since the
   slot is bounded without it and an upstream legitimately slow to its first header byte — an
   inference endpoint, a forge packing a repo — would otherwise get a surprise `502`. P4.1 amendment
   9 carries the full reasoning.

3. **Destination, on the CONNECT target.**
   - The host must be on the operator's allowlist (`MOCA_EGRESS_ALLOW`, Z5 E4), else
     `403 destination_denied` naming the host — never a timeout (P4.1 §8).
   - `moca-egress` resolves the name **once**, checks the resulting address, and dials **that
     address**. Loopback, link-local (including `169.254.169.254`), private and unique-local ranges,
     and the host's own addresses are refused with `403 destination_private`, so no host service —
     Redis on `127.0.0.1:6379`, the control plane — is reachable through the proxy; resolving once and
     dialing the checked address keeps DNS rebinding from changing the destination after the check.
   - A plain-HTTP (absolute-form) request is subject to the same allowlist and address checks against
     its URL's host, and **never receives a credential**: a host that has one is refused over plain
     HTTP (`403 plaintext_credential`) rather than sent a secret in the clear.
4. **Intercept only where a credential applies.** A host that matches `destination.hosts` of a
   credential in the session's `egress` list is TLS-intercepted: SNI must equal the CONNECT host, the
   upstream certificate is verified **before** a leaf is minted (system roots plus
   `MOCA_EGRESS_UPSTREAM_CA`), leaves are short-lived and cached in memory. If upstream verification
   fails for such a host the connection is **refused** (`502 upstream_unverified`), never quietly
   tunnelled. Every other allowlisted host is **tunnelled opaquely**, with a CONNECT audit event. An
   opt-in `MOCA_EGRESS_INSPECT` list forces interception where the audit trail needs request detail.
   Intercepting less keeps less decrypted traffic on the host and less code on the critical path.
5. **Every decrypted request.**
   - `Host` (HTTP/1.1) or `:authority` (HTTP/2) must equal the CONNECT host, else `421` and an audit
     event. The credential decision is therefore always made for the host the connection is dialed to.
   - (grant, host) → credential through the token endpoint, cached (§6.3).
   - The header the credential's `binding` declares (`Authorization: Bearer`, `Basic` for git,
     `x-api-key`, …) is **always overwritten**, whatever the guest sent.
   - `Proxy-Authorization`, hop-by-hop headers and any `X-MOCA-*` header are stripped.
   - Bodies are streamed, never inspected or buffered. HTTP/2 and WebSocket upgrades are allowed; the
     `Host` check applies to the upgrade request.
6. **Audit**, in Z5's shape: `via=moca-egress`, `vm_id`, `sid`, `sub`, `host`, `method`, `path` with the
   query string removed (P4.1 §11 item 4), `status`, `bytes`, the injected credential's **name**, and
   the decision. Structured JSON to journald, behind an audit-sink seam.

### 8.6 The inference listener

The same process serves a second listener for workers (`MOCA_EGRESS_INFERENCE_ADDR`): **loopback
TCP** on `deploy/vm` (default `127.0.0.1:3129`), where workers are host processes; `moca-egress`'s
address on the `moca-brain` network in compose (§9.4). TCP needs no Pi change for Unix sockets. Neither
address is reachable from a sandbox: containers reach the host only through its bridge address, never
its loopback, and microVMs have no network.

`Authorization: Bearer <inference grant>` in → verify (`aud=moca-inference`) → resolve the `inference`
credential → set the header its `binding` declares, drop the P5 sentinel → forward to **the endpoint the
credential names** (or the deployment default the control plane resolved) → stream the response back.
The worker never chooses the upstream, which closes the misdirected-secret class MU1 §6.2 guards
against at the source.

### 8.7 The interception CA

`moca-egress` alone holds the CA private key (`LoadCredential=`). The public certificate is baked into
the golden snapshot, so rotation means rebuilding the snapshot — the stated cost of P4.1 T6. The CA is a
trust anchor for guests only; no host process trusts it.

## 9. Slice S5 — the container tier

### 9.1 What this tier claims

Within one container, sessions share a `/workspace`, a network namespace, a Unix user and a process
list; isolating users _inside_ a container is not achievable. The container tier therefore claims
**per-user isolation — one sandbox container belongs to one user** — and no more. Per-session
isolation, and any claim about the host kernel, belong to the microVM tier.

| Option                                                                                                                                                | Verdict                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **A.** A host launcher creates a user's container on first use and destroys and recreates it on recycle                                               | Deferred (§13). A new component with podman-API access, i.e. host root, plus cold starts                                           |
| **B.** Static owner binding: the operator assigns each sandbox id to one user; the harness leases only a sandbox whose owner equals the grant's `sub` | **Chosen (D6).** No new component. A compose trial is one sandbox for its one user; a small team configures one sandbox per member |
| **C.** One container shared across users (today)                                                                                                      | **Refused** under `multi`, at startup                                                                                              |

A container is never reassigned to another user without being recreated, because a session could leave
a process or file behind for the next owner. Recycling has to happen from outside the container, which is
exactly what option A's launcher would do, and why option B never reassigns.

### 9.2 Owner binding and enforcement

- **One source of truth:** `/etc/moca/sandboxes.json`, read by the relay and `moca-egress`:
  `[{ "id": "sh-sandbox-0", "owner": "github:123", "ip": "10.89.0.10" }, …]`. The owner comes from this
  file, keyed by the **authenticated** sandbox id — never from the sandbox's `Hello` labels, which the
  sandbox chooses (§2.3). The relay writes the owner into the sandbox's record.
- **Per-sandbox tokens are required** under `multi` (`SH_RELAY_TOKEN_<id>` already exists:
  `makeDefaultValidateToken`, `packages/sandbox-relay/src/main.ts:268-283`, prefers it over the global
  token, and R5's `makeExecTokenValidator`, `:78-103`, already refuses an exec token equal to
  either); the relay refuses to start with only the global `SH_RELAY_TOKEN`. A token stolen from inside a container then lets someone re-register only _that_
  sandbox, whose sessions all belong to the same user, so the theft crosses no user boundary.
- **The relay enforces ownership on every `Exec`:** it verifies the sandbox grant and routes to a
  container sandbox only if `grant.sub` equals the sandbox's owner; for a microVM sandbox it passes the
  grant through for `microvm-worker` (§8.2). The in-container `remote-worker` is **not** an enforcement
  point — it runs as the same Unix user as model code, which could kill or replace it.
- **The harness leases by owner:** sandbox selection filters on the record's owner equal to the grant's
  `sub`, so a user's turns never wait on another user's sandbox.

### 9.3 Egress identity on the container tier

`moca-egress` adds a TCP listener on the sandbox network, port 3128 — on the podman network's gateway
address on `deploy/vm`, on `moca-egress`'s own `moca-sandbox` address in compose.
Identity is **source address → sandbox id → owner**, from the same `sandboxes.json`, with a fixed address
per sandbox. A source address is only an identity if it cannot be forged, so sandbox containers run with
`cap_drop: ALL` (no `NET_RAW`, no `NET_ADMIN`) and `no-new-privileges`.

**Credentials resolve per user, not per session, on this tier.** The relay forwards the newest verified
grant for each sandbox to `moca-egress` (`Rebind{sandbox_id, grant}` on the control socket). One session
of a user may then use a credential name that a different session of the **same** user selected. That
crosses no user boundary, and it is the honest consequence of D6.

### 9.4 Network segmentation (R8)

| Network        | Members                                                                                                      | External egress                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `moca-brain`   | supervisor and workers, Redis, control plane, relay `SandboxExec` listener, `moca-egress` inference listener | yes — the control plane (OAuth) and `moca-egress` (upstreams)                                            |
| `moca-sandbox` | sandbox containers, relay `Attach` listener, `moca-egress` container-egress listener                         | **none** (compose `internal: true`, podman `--internal`); sandboxes reach out only through `moca-egress` |

On `deploy/vm`, sandbox containers join a dedicated podman network, isolated from every other podman
network, and resolve `host.containers.internal` to that network's gateway rather than to podman's
`host-gateway`; an nftables rule admits the sandbox subnet to the host only on the relay's `Attach`
port and `moca-egress`'s egress port. Container hardening:
`cap_drop: ALL`, `no-new-privileges`, a read-only root filesystem with tmpfs `/tmp`, the workspace
volume, a pids limit, a non-root user.

## 10. Tenancy mode, rollout, and #348

### 10.1 One switch

`MOCA_TENANCY=single|multi`, read by every component, default `single` — so every existing deployment,
and the Kubernetes path, behaves as today apart from S1's fixes. Under `multi`, every fail-closed
requirement turns on, and **each component refuses to start on an inconsistent configuration**:

| Component        | Refuses to start under `multi` when                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| control plane    | no grant signing key; no `moca-egress` client credential; a development identity provider enabled |
| worker           | `SH_LOCAL_TOOLS=1`; `SH_REQUIRE_AUTH` not `true`                                                  |
| relay            | only the global `SH_RELAY_TOKEN`; a registered container sandbox with no owner entry              |
| `microvm-worker` | no grant public keys                                                                              |
| `moca-egress`    | no CA key, no allowlist, no control-plane credential, no `sandboxes.json` on the container tier   |

**What S1 turns on, and what it only ships.** No deployment artifact in S1 sets `MOCA_TENANCY`:
`service.yaml`, the leaf manifests, compose, `deploy/vm` and the setup scripts all run the `single`
default. So the requirements that §5 applies in both modes are live everywhere after S1, but the
`multi`-only behaviour — R2's ambient-credential scrub and its refusals of `SH_LOCAL_TOOLS=1` and of
`SH_REQUIRE_AUTH` other than `true` — is shipped, tested and **inert** until an operator sets
`MOCA_TENANCY=multi`. That is deliberate. Under `single` the ambient provider key is the operator's
own credential and is meant to stay (§5 R2); the leaf job's mounted `llm-credentials` are that case.
The first deployment that sets `multi` arrives with S2, together with the grants that make a
credential-free worker usable (§10.3).

A misspelled variable name is a boot failure, the same as a misspelled value, rather than being read
as `single`. The rule (`isTenancyNearMiss`, `tenancy.ts`) splits the name into segments, ignoring
case, and strips any `MOCA`, `KAGENTI`, `SH` or `MULTI` glued onto a segment. A name is refused when a
segment is then within one edit of `TENANCY`, or starts with it, and every segment before it is one
of those four words. Once such a leading word has been seen, any segment starting `TENAN` is
refused as well. That catches `SH_TENANCY`, `MULTI_TENANCY`, `SH_MOCA_TENANCY`, `MOCA_TENENCY`,
`MOCA__TENANCY`, `MOCA_TENANCY_MODE`, `MOCA_TENANCIES`, `MOCA_TENANT` and `MOCA_MULTI_TENANT`. It
leaves alone another product's `OCI_CLI_TENANCY`, the word `MAINTENANCE`, a bare `TENANT`, and
Kubernetes service-link variables such as `MOCA_TENANCY_SERVICE_HOST`. So names starting
`MOCA_TENAN`, `SH_TENAN` or `KAGENTI_TENAN` are reserved, and a leftover such as `MOCA_TENANCY_OLD`
must be unset. A test runs the rule over every other identifier in
the repository and asserts that none of them is flagged; names injected at run time, beyond the
service-link shapes, are outside what that test can see.

### 10.2 Order

| Slice  | Content                                                                                                       | Depends on                   |
| ------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **S1** | Hardening, R1–R8 (§5)                                                                                         | nothing — first              |
| **S2** | Grants, token endpoint, `moca-egress` inference listener, direct mode retired under `multi`                   | #348's Kubernetes-free store |
| **S3** | Bundle ownership, session binding, in-memory loading, per-session sandbox copy                                | S2 (`cfg` claim)             |
| **S4** | `moca-egress` egress on the microVM tier, `vmpool` grant binding, the conformance suite (absorbs #277)        | S2                           |
| **S5** | Container tier: owner binding, source-address identity, segmentation                                          | S2; S4's `moca-egress` core  |
| **S6** | Cortex implements the contract and passes the suite at the release adopted (§2.4) — its own spec, later (§14) | S4                           |

### 10.3 What this changes in #348

#348 (a control plane in compose) keeps its goal and most of its items. Four change:

- **Placement.** The control plane and Redis join `moca-brain` only, never the sandbox's network.
- **Secrets as files.** `install.sh` writes the signing key, KEK and exchange token to files mounted as
  compose `secrets:` (mode 0600), not into `.env` (§6.7), and is structured so S2's grant key ring,
  `moca-egress`'s credential and S5's relay exec token and per-sandbox tokens slot in later.
- **Tenancy.** Compose ships as `MOCA_TENANCY=single`. Its item 7 — users' own inference credentials in
  direct mode, and the operator fallback — is safe there because of §6.6's first-subject pin. Multi-user
  compose arrives with S2 and S5. `deploy/vm` is in the same position, and its two-user demo is
  sequenced in §6.6.
- **Order.** #348 adds `SH_EXCHANGE_TOKEN` to the worker environment, so it lands **with or after S1's
  R1**, never before.

A development identity provider (#348 item 6b) must refuse to start under `multi`.

## 11. Failure modes

| Failure                                                   | Behaviour                                                                                      | Why                                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| No or invalid session token under `SH_REQUIRE_AUTH`       | `401` before a session is created                                                              | I5; unchanged from MU1                                                                 |
| Grant expired mid-turn and refresh refused                | the turn ends with a named error; egress returns `403 grant_expired`                           | revocation takes effect; never extended silently                                       |
| Control plane unreachable at refresh                      | the turn ends when the current grant expires                                                   | no grant outlives the authority that issued it                                         |
| Token endpoint unreachable                                | `503` for a host that needs a credential; opaque tunnels unaffected                            | never forwarded without the credential it needs, never with a stale one past its cache |
| `no_credential` / `credential_ambiguous`                  | `401` to the guest; nothing sent upstream                                                      | I4, I5; ambiguity is refused rather than resolved by order                             |
| Destination off the allowlist / private address           | `403 destination_denied` / `destination_private`, naming the host                              | a named refusal is reported; a timeout is retried                                      |
| Plain HTTP to a host that has a credential                | `403 plaintext_credential`; nothing injected                                                   | a secret is never sent in the clear                                                    |
| Inner `Host` ≠ CONNECT host                               | `421`, audited                                                                                 | the credential decision is always for the dialed host                                  |
| Upstream certificate fails for an intercepted host        | `502 upstream_unverified`                                                                      | never tunnelled around the check                                                       |
| Bundle ACL denies, digest missing, verify or layout fails | the session cannot be created, or the turn fails with the digest named                         | I5, I6; no fallback to running unconfigured (promotion design §4.4)                    |
| `Exec` without a valid grant (`multi`)                    | counted `ExecError`; no VM popped                                                              | I2, I7                                                                                 |
| Container `Exec` whose `grant.sub` ≠ owner                | refused at the relay                                                                           | I7                                                                                     |
| `moca-egress` crashes                                     | every guest on the host loses egress until systemd restarts it; `vmpool` re-registers live VMs | P4.1 §8's host-wide blast radius, accepted                                             |
| A guest floods connections                                | `429` at the per-VM cap                                                                        | P4.1 §8                                                                                |
| Worker compromised                                        | exposure bounded to its in-flight grants for ≤ `MOCA_GRANT_TTL_S` (§4.3)                       | D2, stated                                                                             |

## 12. Testing & verification gate

### 12.1 Regression tests for S1

Each requirement R1–R8 is pinned by the test files named in §5's "Pinned by" column, plus P5 §5's
sentinel and ambient-absence cases (`harness/test/model-gateway.test.ts`,
`packages/knative-server/test/server-process.test.ts`) in S1; the two-tenant interleaved **turn** test
lands with S2, where each turn carries its own grant for it to assert on.

### 12.2 Grants

- Mint/verify unit tests over every rejection: wrong `alg`, `alg: none`, wrong `typ`, unknown `kid`,
  wrong `aud`, expired, past `turn_exp`, tampered signature, a session token presented as a grant.
- **Cross-language golden vectors.** The TypeScript signer generates a fixed set of valid and tampered
  grants into a checked-in fixture; the Go verifier shared by `moca-egress` and `microvm-worker`, and
  the TypeScript verifier the relay uses, must accept exactly the valid ones. This is what keeps
  implementations of one check in two languages from drifting.
- Token endpoint: each check in §6.3 fails closed with its named code; a worker's `SH_EXCHANGE_TOKEN`
  is refused at `/internal/token`, and `moca-egress`'s credential is refused at `/internal/turn-grants`.
- **The first-subject pin (§6.6)**, pinned by exact value so the runbooks can quote it. Under `single`,
  the first subject to create a session is served, and keeps being served across a control-plane
  restart. A second subject's session create answers status `403` with code `single_tenant_deployment`,
  and its message makes `MOCA_TENANCY=multi` conditional on per-user sandbox owner binding (S5 on the
  container tier) and cites §6.6. Under `multi`, `sh:cp:tenancy:subject` is never written,
  and two subjects are both served. When this test lands, the two VM runbooks quote its name next to
  the code (#407).

### 12.3 The `moca-egress` conformance suite

A black-box Go suite in a **public** package, `remote-worker/egress/conformance`, plus a runnable
`remote-worker/cmd/moca-egress-conformance`, so that any implementation of the contract — `moca-egress`
first, Cortex later (S6) — runs the same cases against its external interfaces. It must not live under
`internal/`: Go's import rule would stop any other module, Cortex included, from ever running it (the
trap RA1 §0.7 recorded for `vmpool`). Fake upstreams, a fake control plane and a fake `vmpool` speaking
the §8.3 control protocol. Every case is named:

- identity is decided by the accepting connection alone; a forged subject in any header is ignored;
- the placeholder is always overwritten; a credential is never sent to a non-matching host;
- `no_credential` → `401` with **zero** upstream requests;
- inner `Host` ≠ CONNECT host → `421`;
- a plain-HTTP request to a host with a credential → `403 plaintext_credential`, nothing injected;
- off-allowlist → named `403`; private, link-local and metadata addresses → `403`, including a
  **DNS-rebinding** case (a public first answer, a private second);
- SNI ≠ CONNECT host → refused; an upstream certificate failure on an intercepted host → `502`, not a
  tunnel;
- a grant that expires mid-connection; `Unregister` ordering during an in-flight request;
- per-VM connection cap and per-session request cap → `429`;
- exactly one audit event per injection, with the query string removed.

The interception cases for the SBX path (credential lookup, revocation, path scoping, port scoping,
TRACE refusal) are specified in `docs/specs/2026-10-26-sbx-egress-credentials-design.md` §10.2 and run in
this same suite.

### 12.4 Isolation at the worker, and the red-team check

- **Two subjects, interleaved at `await` boundaries** (P5 §5's discipline; a sequential test would pass
  with the bug present): every model request reaches `moca-egress` carrying its own subject's grant;
  neither subject's sandbox environment contains anything of the other's; session A's skills never
  appear in session B's system prompt, including from a warm `ResourceSet`; the SSE branch of `/turn`
  is covered as well as the sync one.
- **Bundles:** a digest the caller neither owns nor was shared is refused **even when it is already warm
  in the worker's cache**; a bundle containing `extensions/x.ts`, `settings.json`, a symlink or a `..`
  segment is refused at load; a compression bomb aborts within the byte bound; the harness's own
  `CLAUDE.md` never appears (promotion design §8's named test, kept).
- **Red-team (Z5 §9 criterion 2, adapted):** after authenticated requests succeed through a fake
  upstream, the real credential value is absent from the worker's environment, every Redis key, the
  session log, the guest's environment and filesystem, and the audit log.

### 12.5 Live gates, behind `MOCA_ISOLATION_LIVE=1`

- **Container tier, compose:** two users, each with a credential, against an echo target that records
  `Authorization`; each call is attributed to the right user; a sandbox cannot reach Redis, the control
  plane or relay `SandboxExec`.
- **MicroVM tier, `nested-m8i`:** the same, with the rootfs digest recorded before and after the run
  (P4.1 §9.1's discipline). The shared KVM rig is announced before use.

### 12.6 Performance

E13 (added latency per proxied request, predicted `< 5 ms` p50) and E14 (the knee stays at `c=8`, bound
`replenishment`) now measure `moca-egress` directly (P4.1 §9). Grant verification on `Exec` gets a
prediction sealed before E8's next rung, since it sits on the hot path.

## 13. Scope / YAGNI — explicitly NOT building

- **A container launcher** (§9.1 option A). Revisit if the container tier needs many users.
- **A revocation list.** Short grant and credential-cache lifetimes do that job (§6.2).
- **Rebinding a session's bundle** (`PATCH`). Sessions are immutable in `cfg` (§7.2).
- **Host-side read-only bundle materialization** (§7.4 v2), until the push cost is measured.
- **Asynchronous and scheduled leaf grants.** MU2 builds them, under §6.5's requirement.
- **Unix-user separation inside containers** (R6's optional hardening); it needs `CAP_SETUID`, which
  conflicts with `cap_drop: ALL`.
- **Per-team or per-session egress allowlists.** One operator allowlist per deployment, as Z5 scoped.
- **Request-signing APIs** (AWS SigV4 and similar), Z5 E8's escape hatch — deferred as Z5 deferred it.
- **Request-body inspection, MCP parsing, IBAC/SPARC/OPA policy, HTTP/3** in `moca-egress`. These are
  Cortex's strengths and the reason S6 exists.
- **An external authorization server** (D5).
- **A multi-user mode on the Kubernetes path.** RA1 deprecates it; it keeps `single` behaviour.
- **Subject on every log line** (rossoctl/moca#359). P5 requires per-session attribution per log line
  (`2026-09-06-p5-session-isolation-design.md`, the `TurnConfig.subject` paragraph). S1 logs no
  subject, so in a worker multiplexing S sessions a line cannot be attributed. This belongs to the
  first slice that multiplexes users (S2).
- **Per-user admission quota** (rossoctl/moca#360). `packages/supervisor/src/admission.ts` bounds the worker as a whole,
  so one user can use every slot. This belongs with S2's grants, which name the user.
  **Closed in-product 2026-10-15 (rossoctl/moca#542):** the subject is known to the worker after `resolveTurnAuth`, and only there, so the
  cap is enforced at that point (`packages/knative-server/src/subject-quota.ts`, wired into `handleTurn`): a subject
  over `SH_TURNS_PER_SUBJECT` in-flight turns — default half the per-worker slots, `max(1, ⌊S/2⌋)` — is refused with
  `429 subject_quota_exceeded` plus `Retry-After`, distinct from the supervisor's pool-wide `overloaded` so a client
  can tell "you are over your share" from "the host is full". The count is per-worker, not host-wide: no shared state
  joins the turn hot path (this tier's own rule — a Redis that cannot answer must not gate a caller), and the bound it
  buys is `cap/S` of the host. An unauthenticated caller has no subject and no slot. Moving enforcement to the
  supervisor — exact and host-wide, on grants that name the user — remains with S2, as this clause already recorded.
- **Tenant-scoped session listing** (rossoctl/moca#361). `RedisSessionBackend.list()`
  (`packages/session-backend/src/redis-backend.ts`) returned every tenant's sessions. No route ever
  exposed it to a caller, and no caller-facing use was to be added before S2 scoped it.
  **Closed in-product 2026-10-15 (rossoctl/moca#541):** `list()` is deleted from `LogStore` and
  `RedisSessionBackend` (nothing called it, so no SCAN-based admin listing was kept), and
  `BufferedRedisBackend.list()` — which Pi's `SessionStorageBackend` requires — now throws an error
  naming the scoped path, making this §13 clause structural rather than advisory. The scoped listing
  remains `OwnershipIndex.listByOwner` (§7.1-§7.3), with the cross-tenant isolation test in
  `packages/control-plane/test/ownership.test.ts`.
- **Blocking cloud instance metadata from sandboxes** on `deploy/vm` (rossoctl/moca#357). R8 filtered only the input
  hook, so a sandbox could reach `169.254.169.254` and, on an IMDSv1 or hop-limit-2 EC2 host, the
  instance role's credentials. **Closed in-product 2026-10-15 (rossoctl/moca#539):** the
  `moca_sandbox` table now drops link-local destinations from the sandbox bridge in its forward
  chain. Metadata served from routable addresses (Alibaba's `100.100.100.200`, Azure's WireServer
  `168.63.129.16`) remains for S5's egress filtering; `deploy/vm/README.md` still gives the
  platform-side mitigation as defense in depth.
- **An atomic workload create** (rossoctl/moca#356). `POST /workloads` checks for another subject's live workload, then
  creates. Two subjects creating one new name concurrently can both succeed, and the later write's
  owner wins. Closing it needs a set-if-absent owner reservation before Context Service is called.
- **Per-subject PVC authorization and subject-scoped workload names** for `/workloads` (rossoctl/moca#358). Under `multi`
  and from any authenticated caller, a caller-named `workspace.claimName` is refused instead (§4.3). `docs/context-service.md` states the
  boundary.
- **Any `pi-fork` change.**

## 14. Records, amendments, and the Cortex path

**ADR-0037** — _Session grants and `moca-egress`: connection-bound credential injection on the density
substrate_ — records D2, D4, D5 and D7, written with S2. It supersedes P4.1 §12.2's presumption that a
thin shim in front of AuthBridge is the answer: §12.2 said a proxy of our own "only wins if Z5's
semantics turn out not to fit a shared, non-Kubernetes proxy at all — which would be a finding about
Z5, and should be written up as one". §2.4 is that write-up — a finding about Cortex's current
capabilities, not Z5's semantics, which this design keeps whole.

Amendment notes, each a short dated paragraph at the head of the amended spec, pointing here:

| Spec               | Amended section | What changes                                                                                                         |
| ------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------- |
| P4.1               | §12.2           | the proxy is `moca-egress`; the caller-identity interface binds VM → session through the sandbox grant               |
| P5                 | §3.2            | the per-request credential is a signed grant, not a subject-derived placeholder                                      |
| MU1                | §5.3, §3.6      | `/internal/turn-grants` replaces `/internal/credentials`; direct mode only under `single` with the first-subject pin |
| Workflow promotion | §4.4, §4.5      | in-memory loading, no harness-side unpack; per-session sandbox copy, no shared cache in `multi`                      |
| MU1 (2026-11-05)   | §4.2, §4.3, §9  | MU2's owned `/v1/runs` is `async:true` on a session (#279); the data-plane async half stays removed                  |
| This spec (MI1)    | §6.1, §6.5, §10 | owned async dispatch is `async:true` on a session; `turn_exp` is unbuilt; turn start = dequeue — P6AF, ADR-0047      |

**The Cortex path (S6).** cortex#905 is rescoped to the contract in §8 and the suite in §12.3. Cortex
replaces `moca-egress` when **both** hold: it passes that suite unchanged, run against the pinned
Cortex release being adopted rather than inferred from §2.4's reading at `403d5d2`, and MOCA needs a
capability only Cortex has. The swap is then a process replacement, because the token endpoint is
RFC 8693-shaped (§6.3) and audit events follow Z5's shape (§8.5). Switching only to switch would add a
hop and a larger attack surface for nothing.

## 15. Configuration surface

New settings use the `MOCA_` prefix (see the header's naming note). From S2, secrets are **files**,
never environment variables (§6.7); S1's one new secret, `MOCA_RELAY_EXEC_TOKEN`, is an environment
variable until then.

| Setting                                 | Read by                                | Default                    | Meaning                                                                                          |
| --------------------------------------- | -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `MOCA_TENANCY`                          | every component                        | `single`                   | `single` \| `multi` (§10.1)                                                                      |
| `MOCA_GRANT_SIGNING_KEY` _(file)_       | control plane                          | —, required under `multi`  | grant key ring, newest first                                                                     |
| `MOCA_GRANT_PUBLIC_KEYS`                | `moca-egress`, `microvm-worker`, relay | —, required under `multi`  | `kid:base64-DER`, comma-separated                                                                |
| `MOCA_GRANT_TTL_S`                      | control plane                          | `300`                      | grant lifetime (§6.2)                                                                            |
| `MOCA_TURN_MAX_S`                       | control plane                          | `1800`                     | `turn_exp` cap; should match the worker's own turn deadline                                      |
| `MOCA_TOKEN_TTL_S`                      | control plane                          | `60`                       | upper bound on the token endpoint's `expires_in` (§6.3)                                          |
| `MOCA_EGRESS_CP_TOKEN` _(file)_         | control plane, `moca-egress`           | —, required under `multi`  | `moca-egress`'s credential for `/internal/token`                                                 |
| `MOCA_EGRESS_ALLOW`                     | `moca-egress`                          | —, required                | destination host allowlist (Z5 E4)                                                               |
| `MOCA_EGRESS_INSPECT`                   | `moca-egress`                          | empty                      | extra hosts to intercept for audit detail (§8.5)                                                 |
| `MOCA_EGRESS_UPSTREAM_CA` _(file)_      | `moca-egress`                          | system roots only          | additional upstream trust, e.g. an internal CA                                                   |
| `MOCA_EGRESS_CA` _(file)_               | `moca-egress`                          | —, required                | interception CA key and certificate                                                              |
| `MOCA_EGRESS_INFERENCE_ADDR`            | `moca-egress`                          | `127.0.0.1:3129`           | inference listener (§8.6)                                                                        |
| `MOCA_EGRESS_MAX_CONNS_PER_VM`          | `moca-egress`                          | `32`                       | per-VM (or per-container) concurrent connections                                                 |
| `MOCA_EGRESS_MAX_REQUESTS_PER_SESSION`  | `moca-egress`                          | `10000`                    | Z5's hard per-session cap                                                                        |
| `MOCA_EGRESS_IDLE_TIMEOUT_S`            | `moca-egress`                          | `300`                      | idle bound on an established connection, refreshed per byte (§8.5)                               |
| `MOCA_EGRESS_RESPONSE_HEADER_TIMEOUT_S` | `moca-egress`                          | the idle bound             | how long a forwarded request waits for its response headers (§8.5)                               |
| `MOCA_RELAY_EXEC_TOKEN`                 | relay, workers                         | —, required                | worker credential for `SandboxExec` (R5); an environment variable in S1, a file per §6.7 from S2 |
| `MOCA_RELAY_EXEC_ADDR`                  | relay                                  | unset ⇒ one listener       | binds `SandboxExec` on its own listener, split from attach (R5)                                  |
| `MOCA_RELAY_EXEC_PORT`                  | compose                                | `9444`                     | exec listener port, brain-side only                                                              |
| `MOCA_BRAIN_SUBNET`                     | compose                                | `172.31.250.0/24`          | `moca-brain` network subnet (R8)                                                                 |
| `MOCA_RELAY_BRAIN_IP`                   | compose                                | `172.31.250.10`            | relay's address on `moca-brain`, where `MOCA_RELAY_EXEC_ADDR` binds                              |
| `MOCA_SANDBOX_SUBNET`                   | `deploy/vm`                            | `10.89.40.0/24`            | dedicated podman network subnet for sandbox containers (R8)                                      |
| `MOCA_SANDBOX_GATEWAY`                  | `deploy/vm`                            | `10.89.40.1`               | gateway on that subnet; `host.containers.internal` inside a sandbox                              |
| `MOCA_SANDBOX_BRIDGE`                   | `deploy/vm`                            | `moca-sandbox0`            | that network's bridge interface; the firewall matches sandbox traffic by it                      |
| `MOCA_SANDBOXES_FILE`                   | relay, `moca-egress`                   | `/etc/moca/sandboxes.json` | container sandbox id → owner → address (§9.2)                                                    |
| `MOCA_BUNDLE_MAX_BYTES`                 | control plane, worker                  | `8388608`                  | compressed bundle cap (§7.3)                                                                     |
| `MOCA_BUNDLE_CACHE_BYTES`               | worker                                 | `134217728`                | per-worker `ResourceSet` LRU bound                                                               |
| `SH_LOCAL_TOOLS`                        | worker                                 | unset                      | development opt-in to local tools; refused under `multi` (R3)                                    |

Defaults marked as numbers are starting points; E8/E14 may move them.

## 16. Implementation notes for a fresh session

**Files, by slice** — S1 as shipped in PR #350, by requirement; S2–S5 decided rather than deferred, so a
planner does not have to choose:

| Slice   | Paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 R1   | `packages/k8s-sandbox/src/sandbox-env.ts` (the allowlist, exported from `index.ts`) applied by `createPodBashOps` in `src/operations.ts` — an allowlist filter, not a fail-closed spawn hook                                                                                                                                                                                                                                                                                                                                                                                                                              |
| S1 R2   | `harness/src/run-turn.ts` (`applyModelGateway` seeds only the sentinel), `harness/src/ambient-sentinel.ts` (the constant, a `package.json` export); `packages/knative-server/src/server-process.ts` (`prepareServerProcess`: scrub, refusals, private agent directory), `tenancy.ts` (`readTenancy`), called by `startServer` in `server.ts`, the P6 worker in `worker.ts` and the async-run job in `leaf-job.ts`                                                                                                                                                                                                         |
| S1 R3   | `harness/src/select-sandbox.ts` (`assertServerSandbox`, `SandboxRequiredError`), called from `executeTurn` in `run-turn.ts` and from `realProduceSolve`/`realProduceVerdict` in `run-leaf.ts`; `server.ts` `buildConfig` marks every server turn `serverMode`                                                                                                                                                                                                                                                                                                                                                             |
| S1 R4   | `harness/src/run-turn.ts` (`turnLoaderInputs`), used by `executeTurn` and both leaf producers in `run-leaf.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| S1 R5   | `packages/sandbox-relay/src/main.ts` (`makeExecTokenValidator`, the `MOCA_RELAY_EXEC_ADDR` split); the worker side in `harness/src/select-sandbox.ts` (`makeRelayExecClient`) and `remote-worker/cmd/exec-driver/{main,plan,drive}.go`; the token in `deploy/knative/relay-deployment.yaml`, `overlays/ocp/patch-relay-token.yaml`, `setup-ocp.sh`, `demo-remote-worker.sh`, `relay-leaf-smoke.sh`, `remote-worker/deploy-incluster.sh` and `run-local.sh`; compose's `install.sh` and `smoke.sh` generate it; `deploy/vm/env/*.env.example` and `setup-vm.sh`'s `ensure_exec_listener` put the exec listener on loopback |
| S1 R6   | `remote-worker/internal/exec/sandboxenv.go` (`commandEnv`), set as `cmd.Env` in `runner.go`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| S1 R7   | `packages/knative-server/src/server.ts` (`/runs`, `/v1/runs`, `/runs/status`, `/workloads` ownership), `turn-auth.ts` (`authorizeRunRead`, `authenticateSubject`), `context-service.ts` (a workload's `owner`)                                                                                                                                                                                                                                                                                                                                                                                                            |
| S1 R8   | `deploy/compose/docker-compose.yml` (the two networks, and R5's brain-side exec listener); `deploy/vm/setup-vm.sh` (`ensure_sandbox_network`, `install_sandbox_firewall`) and `systemd/moca-sandbox-firewall.service`                                                                                                                                                                                                                                                                                                                                                                                                     |
| S1 Docs | `deploy/compose/README.md`, `deploy/vm/README.md`, `deploy/knative/README-worker.md`, `remote-worker/DESIGN.md`, `docs/demos/remote-sandbox-demo.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| S2      | `packages/control-plane/src/token.ts` (generalized over `typ`/`aud`), new `grants.ts` and `token-endpoint.ts`, `exchange.ts` → turn-grants, `routes.ts`; `packages/knative-server/src/turn-auth.ts` (turn-grants, refresh); `harness/src/run-turn.ts` (`grant` mode, every model API); `remote-worker/internal/grant` (Go verifier); `remote-worker/cmd/moca-egress` + `internal/egress` (inference listener)                                                                                                                                                                                                             |
| S3      | `packages/control-plane` bundle routes + ACL; `harness/src/config-store.ts` (bounded decompression); a new `harness/src/resource-set.ts` replacing `config-resolver.ts`'s disk unpack; `harness/src/config-overlay.ts` (per-session path); `harness/src/promote-cli.ts` (upload via control plane); `packages/config-bundle/src/lockfile.ts` (relative paths)                                                                                                                                                                                                                                                             |
| S4      | `proto/sandbox/v1/sandbox.proto` (`Exec.grant = 7`) and generated code; `harness/src/select-sandbox.ts` and the gRPC transport (carry the grant); `remote-worker/internal/vmpool` (grant binding, socket creation, `SCM_RIGHTS`); new `proto/egress/v1/control.proto`; `remote-worker/internal/egress` (forward proxy, interception, policy); the **public** `remote-worker/egress/conformance` package and `remote-worker/cmd/moca-egress-conformance` (§12.3); `remote-worker/cmd/guest-agent` (P4.1 T2 loopback splice); `deploy/microvm/build-snapshot.sh` (CA certificate, placeholder env, git credential helper)   |
| S5      | `packages/sandbox-relay` (owner map, grant check with the TypeScript verifier shared with the control plane rather than a second copy, `Rebind` to `moca-egress`); `moca-egress` container listener; `deploy/compose`, `deploy/vm` networks and hardening                                                                                                                                                                                                                                                                                                                                                                 |

**No `pi-fork` changes.** Every Pi behaviour this design needs is an existing option (§2.1) or the
`user_bash` event, which `packages/k8s-sandbox/src/extension.ts` handles with `pi.on('user_bash', …)`.

**House rules that bite here.** A new package needs a `tsconfig.json` with `test` in its include and a
`typecheck` script, or `harness/test/typecheck-coverage.test.ts` fails. `make lint` skips untracked
files — stage new files first. Tests need the `sh-test-redis` container on `:6379`; ~10 `ECONNREFUSED`
failures across 4 files means it is stopped. A fresh worktree needs `git submodule update --init
--recursive`, `cd pi-fork && npm ci && npm run build`, then `pnpm install`. Plans are not committed
(`docs/plans/` is gitignored). Commits are `git commit -s` with
`Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>`.

## 17. References

- [P6](2026-09-08-p6-vm-process-manager-design.md) · [ADR-0034](../adrs/0034-vm-process-manager-socket-handoff.md) — the multiplexed worker this design makes multi-user.
- [P4](2026-09-09-p4-microvm-sandbox-design.md) · [ADR-0035](../adrs/0035-per-exec-microvm-warm-standby.md) — per-`Exec` microVMs, jails, the no-secrets-in-the-snapshot invariant.
- [P4.1](2026-09-15-p4-1-microvm-egress-transport-design.md) — the vsock egress hop, T1–T7; §12.2 amended here. Issues [#277](https://github.com/rossoctl/serverless-harness/issues/277), [#278](https://github.com/rossoctl/serverless-harness/issues/278).
- [P5](2026-09-06-p5-session-isolation-design.md) · [ADR-0032](../adrs/0032-per-request-subject-no-ambient-credential.md) — per-request subject, no ambient credential; its scrub is S1's R2.
- [MU1](2026-09-08-multi-user-control-plane-design.md) · [ADR-0033](../adrs/0033-multi-user-control-plane.md) — session tokens, the exchange, the credential store.
- [Workflow promotion](2026-09-02-claude-code-workflow-promotion-design.md) · [ADR-0030](../adrs/0030-claude-code-workflow-promotion.md) · [ADR-0031](../adrs/0031-promoted-memory-read-only.md) — the bundle format and pipeline §7 builds on.
- [Z1](2026-06-26-identity-spine-design.md) — tiers, the forbidden "shared identity + subject header" pattern, the authoritative binding store.
- [Z5](2026-06-19-m13-generalized-credentialed-egress-design.md) — forward proxy, placeholder swap, allowlist as exfiltration boundary, audit shape.
- [RA1](2026-09-24-ra1-density-cutover-and-repo-rearchitecture-design.md) — the Kubernetes-free substrate and the MOCA name.
- [#348](https://github.com/rossoctl/serverless-harness/issues/348) — compose control plane; §10.3.
- [cortex#905](https://github.com/rossoctl/cortex/issues/905) — per-subject resolution in Cortex, rescoped to this contract.
- RFC 8693 (OAuth 2.0 Token Exchange), RFC 7515 (JWS), RFC 8037 (EdDSA in JOSE).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
