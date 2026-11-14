# SBX0 security review: the 1c gate

The [SBX0 spec](../specs/2026-10-15-sbx0-internal-sandbox-service-design.md) §9 makes a security
review the gate before the internal cohort opens (increment 1c). This document is that review's
**input and its record**: a checklist with a pointer to the evidence for each item, the claims SBX0
makes and what each rests on, what it does not claim, and the reviewer's sign-off. The review
itself is a human step: nothing here is signed off until §5 is filled in.

**Evidence status**, used throughout:

- **Tested**: a named automated test asserts it, and it ran green on the date given. "Mutation"
  adds that deleting or weakening the check made a test fail.
- **By construction**: no test asserts it; it follows from code or a contract this change does not
  touch, named in the row. The reviewer reads the pointer.
- **Verified live**: shown by the live acceptance against a deployed namespace (spec §10.6),
  on the date given. §4 records the run, including the exact code it used.

Verified on 2026-10-19, on the branch at the commit that adds this file, unless a row says
otherwise. Test paths are relative to the repository root. The live acceptance (the rows that
needed it) ran 2026-10-20; §4 records it.

## 1. The checklist (spec §9, "Reviewed before the cohort opens")

### 1.1 The relay's verifier, against §10.2's matrix, with mutation evidence

On every `Exec` and `Abort`, before routing, the relay refuses a token that does not verify, and an
`Exec` outside the token's own worker and workspace (spec §3.2).

| §10.2 case                                                                   | Evidence (`packages/sandbox-relay/test/sandbox-token.transport.test.ts` unless named)                                                                                       | Status            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `alg: none`; unknown `kid`; wrong `typ`; wrong `aud`; wrong `iss`            | "refuses an Exec with %s, UNAUTHENTICATED, before routing" (table rows of the same names)                                                                                   | Tested + mutation |
| expired outside the leeway; inside it accepted                               | the same table ("a token expired beyond the leeway"); "accepts a token expired by less than the 30 s leeway"                                                                | Tested + mutation |
| missing `exec` scope; bad signature                                          | the same table ("a missing exec scope", "a tampered signature")                                                                                                             | Tested + mutation |
| an API or session token presented as a sandbox token                         | the same table ("an API token…", "a session token…")                                                                                                                        | Tested + mutation |
| `sandbox_id` ≠ `wrk`; `workspace_key` ≠ `wsk`, a prefix, an extension, empty | "refuses an Exec on %s, PERMISSION_DENIED, before routing" (another worker / workspace / prefix / extension / empty key)                                                    | Tested + mutation |
| `Abort` of another `sbx`'s Exec; of a finished Exec; on another worker       | "refuses to Abort another sandbox's Exec…", "refuses to Abort a finished Exec…", "refuses an Abort for the right req_id on another worker"                                  | Tested + mutation |
| per-sandbox `req_id` (§3.6): same id and command from two sandboxes          | "runs the same req_id and command from two sandboxes as two worker Execs…"; "maps B's Abort of a shared req_id to B's own Exec, never A's"                                  | Tested + mutation |
| no Exec outlives its token (§3.6)                                            | the expiry tests (aborted at `exp` + leeway, `DEADLINE_EXCEEDED`; the timer cleared when the Exec ends first)                                                               | Tested + mutation |
| the in-flight cap (§3.6)                                                     | "admits two, refuses a third RESOURCE_EXHAUSTED before routing, and admits again after one ends"                                                                            | Tested + mutation |
| the harness token first in precedence; none in an SBX0 relay                 | "checks the harness token first…" (mutation); `deploy/sbx/tests/overlay.test.sh` "the relay takes sandbox tokens and nothing else (no exec token, no static client tokens)" | Tested + mutation |

**Mutation evidence.** 1b's Task 6 deleted or weakened each of the 24 checks in turn (the token
checks in `packages/control-plane/src/token.ts` and `sandbox-token.ts`, the relay's rules in
`packages/sandbox-relay/src/main.ts`), and every mutant made at least one test in
`sandbox-token.transport.test.ts` or `sandbox-auth.test.ts` fail: **24/24 killed** (2026-10-16).
1c's Task 7 then moved the relay's rules into `sandbox-caller.ts` and `exec-stream.ts`. So, for
this review, the same 24 mutants were re-applied at their new sites and re-run on 2026-10-19:
**24/24 killed again**, every source file byte-identical afterwards (checked with `cmp`), and the
relay suite 194/194 green. The mutant list and the tests each one failed are kept with the plan's
working files, not in the repository.

### 1.2 The `sandbox` profile mounts no harness route (spec §4.1)

| Item                                                                 | Evidence                                                                                                                                                | Status                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every route declares its profiles; one added without a profile fails | `packages/control-plane/test/route-profile.test.ts` "declares a non-empty profile list on every route"                                                  | Tested                                                                                                                                                                                                              |
| under `sandbox`, every harness-only route is the unknown-path 404    | the same file, "answers every harness-only route with the unknown-path 404 under the sandbox profile"                                                   | Tested                                                                                                                                                                                                              |
| under `harness`, every sandbox route is a 404                        | the same file, "answers every sandbox-only route with the unknown-path 404 under the harness profile"                                                   | Tested                                                                                                                                                                                                              |
| shared routes are exactly the probes, discovery and login            | the same file, "shares exactly the probe, discovery and login routes between the two profiles"                                                          | Tested                                                                                                                                                                                                              |
| the deployed control plane runs the `sandbox` profile                | `deploy/sbx/tests/overlay.test.sh` "the control plane runs the sandbox profile with only its signing key and the janitor token mounted"                 | Tested                                                                                                                                                                                                              |
| the deployed profile, from outside                                   | a harness route (for example `/v1/sessions`) on `https://<api host>` answers 404. Not a step of `deploy/sbx/smoke.sh`: check it by hand at the live run | Verified live, 2026-10-20 (§4): `/v1/sessions` and `/v1/turns` answer the unknown-path 404 on the deployed api host; the shared probes answer 200; `/v1/sandboxes` answers 401 (present and auth-gated, not hidden) |

### 1.3 Ownership returns 404, and the allowlist gates every route

| Item                                                                                       | Evidence                                                                                                                                                                                                | Status                                                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| every `/v1/sandboxes/{id}` route hides another user's sandbox as `sandbox_not_found` (404) | `packages/control-plane/test/route-authz-enumeration.test.ts` "makes EVERY sandbox-scoped route hide another user's sandbox with sandbox_not_found"                                                     | Tested                                                              |
| every such route is declared sandbox-scoped, and only those                                | the same file, "declares every /v1/sandboxes/{id} route sandbox-scoped, and only those"                                                                                                                 | Tested                                                              |
| an admin cannot mint for another user's sandbox (404)                                      | `packages/control-plane/test/sandbox-handlers.test.ts` "never mints for an admin on another user's sandbox: 404 sandbox_not_found"                                                                      | Tested                                                              |
| an unlisted subject is refused `not_enrolled` on login and on every sandbox route          | `packages/control-plane/test/sandbox-enrollment.test.ts` "refuses a device-flow login by an unlisted subject…"; `sandbox-handlers.test.ts` "refuses everything to a subject who is not enrolled"        | Tested                                                              |
| a removed subject is stopped at the next refresh, its refresh family revoked               | `sandbox-enrollment.test.ts` "stops a de-enrolled subject at the next refresh", "revokes the family of a de-enrolled refresh…"                                                                          | Tested                                                              |
| the janitor route takes only the janitor bearer; 401 when unset                            | `route-profile.test.ts` "serves the janitor read only with the janitor bearer", "refuses the janitor read to everyone when SH_JANITOR_TOKEN is unset", "never takes the janitor bearer as a user token" | Tested                                                              |
| user B cannot reach user A's sandbox in a deployment (`PERMISSION_DENIED` and 404)         | spec §10.6 step 2: `deploy/sbx/smoke.sh` step 2 checks it when run (B's mint and env are `no such sandbox`; B's token on A's ids is `PERMISSION_DENIED`)                                                | Verified live, 2026-10-20 (§4; smoke step 2, green in the full run) |

### 1.4 The routes' exposure

The exec and attach Routes are reachable from the internal network; every exec call needs a valid
sandbox token (§1.1), and every attach its worker's relay token.

| Item                                                                                     | Evidence                                                                                                                                                                                                                                                                    | Status                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| attach and exec Routes are passthrough (gRPC never crosses the router's TLS termination) | `deploy/sbx/tests/overlay.test.sh` "the attach and exec Routes are passthrough"; "two ghostunnel sidecars: attach -> :9443, exec -> :9444"                                                                                                                                  | Tested                                                                                                                                                                                                                                                                                                       |
| the API Route is edge-terminated, to the control plane only                              | the same file, "the API Route is edge-terminated, to the control plane"                                                                                                                                                                                                     | Tested                                                                                                                                                                                                                                                                                                       |
| the only ingress to the relay and control plane is the router namespace, on their ports  | the same file, "the only ingress to the relay pods is the router namespace, on 8444 and 8445", "the only ingress to the control plane is the router namespace, on 8080"                                                                                                     | Tested                                                                                                                                                                                                                                                                                                       |
| no in-cluster relay Service; the exec listener on loopback                               | the same file, "no in-cluster relay Service…", "the exec listener is bound to loopback, so only the sidecar reaches it"                                                                                                                                                     | Tested                                                                                                                                                                                                                                                                                                       |
| the control plane has no Kubernetes API egress                                           | the same file, "the control plane has no Kubernetes API egress (6443)"                                                                                                                                                                                                      | Tested                                                                                                                                                                                                                                                                                                       |
| each worker attaches with its own relay token; a dropped worker is revoked               | `deploy/sbx/tests/setup.test.sh` "creates every Secret and ConfigMap, one worker token per worker, no exec or client tokens", "dropping a worker revokes its token and deletes its bundle (via explicit null patch)"                                                        | Tested                                                                                                                                                                                                                                                                                                       |
| the deployed Routes refuse an exec without a token, and an attach without a worker token | spec §10.6 step 2; the attach refusal is seen in `install-host.sh`'s wait when a token is wrong. `deploy/sbx/smoke.sh` step 2 sends a wrong token's Exec, not a tokenless one: check an Exec with no token (UNAUTHENTICATED) and the attach refusal by hand at the live run | Verified live, 2026-10-20 (§4): a tokenless Exec is refused `UNAUTHENTICATED` before routing (relay audit: `outcome: refused`, `reason: no bearer token`, no `sub`); an Attach whose `Hello` carries no worker bearer is closed by the relay without a single `ServerFrame` — the worker is never registered |

### 1.5 Secrets out of argv, logs and the audit; secrets not pushed

| Item                                                                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                                                   |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `setup.sh` puts no token or key in argv or its log                                  | `deploy/sbx/tests/setup.test.sh` "no token or key reaches argv or the log"                                                                                                                                                                                                                                                                                                                                              | Tested                                                                   |
| the janitor's token stays out of argv and the log; a readable token file is refused | `deploy/sbx/tests/janitor.test.sh` "one JSON summary line…; the token never in argv"; "refuses … a token file others can read…"                                                                                                                                                                                                                                                                                         | Tested                                                                   |
| the audit line has no command text, output or token (unless the debug flag)         | `packages/sandbox-relay/test/audit.transport.test.ts` "writes one line with the caller, the outcome and the stdout size, and no command or output"; "adds the command only with SH_SANDBOX_AUDIT_COMMANDS=1"                                                                                                                                                                                                            | Tested + mutation (1c Task 7: 33/33 killed, 2026-10-18; not re-run here) |
| an unverified token's claims are never logged                                       | the same file, "records UNAUTHENTICATED as refused with the verifier reason and NO sub or sbx, even when the token parsed"                                                                                                                                                                                                                                                                                              | Tested                                                                   |
| `.env*`, `*.pem`, `*.key`, `id_*` are not pushed unless asked                       | `packages/mocactl/test/sbx-push.test.ts` "lists tracked files … never ignored ones or secrets"; "includes the secrets only when asked, and matches each pattern on the basename"                                                                                                                                                                                                                                        | Tested                                                                   |
| `status.sh` is read-only                                                            | `deploy/sbx/tests/status.test.sh` "cluster: read-only…", "host: … read-only"                                                                                                                                                                                                                                                                                                                                            | Tested                                                                   |
| pull --apply cannot write local agent config or hooks                               | `packages/mocactl/test/sbx-push.test.ts` "pull --apply never writes local agent configuration or hooks (final review C1)": the review's probe patch (an emptied `permissions.deny`, a `SessionStart` hook, a new `.mcp.json` server) is refused with tree and index byte-identical; every listed path and look-alike (`.CLAUDE/`, `.ｍｃｐ.json`, `sub/.claude/settings.json`) is refused; `.git` and `.sbx/` as before | Tested (2026-10-19)                                                      |

## 2. What SBX0 claims (spec §9), and the evidence

| Claim                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                   | Status                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No process survives a call                                                   | P4's `TestGateNoVMReuse` and `TestGateLeakFreeTeardown` (`remote-worker/internal/vmpool/gates_kvm_test.go`), unchanged by SBX0                                                                                                                                                                                                                                                                                             | By construction here; those gates need `/dev/kvm` and run only on the rig (`.github/workflows/microvm-kvm-gates.yml`, manual). Not re-run for this review                       |
| No network in the guest                                                      | P4's Firecracker launcher issues no `PUT /network-interfaces` (`remote-worker/internal/vmpool/launcher_firecracker.go`), unchanged by SBX0                                                                                                                                                                                                                                                                                 | By construction. Checked live 2026-10-20 (§4) in a deployed sandbox: name resolution fails (`gaierror`) and a raw connect by address fails with errno 101 (network unreachable) |
| A user reaches only their own sandboxes                                      | §1.1 (exact `wrk`/`wsk`, per-sandbox `req_id`, `Abort` ownership), §1.3 (404 on others)                                                                                                                                                                                                                                                                                                                                    | Tested + mutation; deployed: verified live 2026-10-20 (§4; smoke step 2, green in the full run)                                                                                 |
| An admin cannot exec into another user's sandbox                             | §1.3 (owner-only mint, 404 for an admin)                                                                                                                                                                                                                                                                                                                                                                                   | Tested                                                                                                                                                                          |
| Tokens never enter the guest                                                 | The relay forwards `ExecRequest {sandbox_id, exec}` only (`proto/sandbox/v1/sandbox.proto`: `Exec` has no token field), and the worker never receives the caller's metadata; unchanged by SBX0                                                                                                                                                                                                                             | By construction                                                                                                                                                                 |
| Access ends at expiry (30 s leeway), and within one token lifetime of delete | `packages/control-plane/test/sandbox-handlers.test.ts` "refuses to mint once deleted (with the reason) or expired…"; `packages/control-plane/test/sandbox-token.test.ts` "caps exp at the sandbox expiry, and refuses to mint for an ended sandbox", "accepts 30 s of clock skew past exp, and no more"; the relay's leeway and expiry cancel (§1.1). One token lifetime is `SBX_TOKEN_TTL_MINUTES`, 15 minutes by default | Tested; deployed: verified live 2026-10-20 (§4; smoke step 4, green in the full run)                                                                                            |

### 2.1 Egress credentials (SBX0.2b, [spec](../specs/2026-10-26-sbx-egress-credentials-design.md))

Rows for the user-scoped credential injection. The live acceptance (plan Task 15) ran on
2026-10-28: two rows carry its evidence, and only the second-user row is still pending.

| Claim                                                                                                                            | Evidence                                                                                | Status                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A second user's sandbox never receives the first user's credential (spec §1.2 item 3)                                            | live: a second user's sandbox, no credential, gets a `401` from `gh api user`           | pending: second-user run not done (skipped 2026-10-28 by the operator)                                                                                                                                      |
| The token is absent from the guest's environment, files and `/proc/*/mem` (spec §1.2 item 4)                                     | live: scan for the token's value after an authenticated push                            | Tested live 2026-10-28: KVM gate TestGateCredentialNeverInGuest passed on the SBX KVM host (snapshot default-p41-ca); positive control canary found in a file, an environ and memory, fixture found nowhere |
| The placeholder is inert: sent directly to `api.github.com` it gets `401` (spec §1.2 item 5)                                     | live: request from outside the sandbox                                                  | Tested live 2026-10-28: smoke step 7, placeholder sent to api.github.com/user from outside the sandbox → 401                                                                                                |
| Phase 1 resolves by owner: a stolen host token yields the credentials of live sandboxes on that host (spec §8)                   | bounded by E4 (one token per host, that host's workers only) and audited per issuance   | Accepted risk; closed by ADR-0046 phase 2                                                                                                                                                                   |
| A `Set-Cookie` an upstream mints from the injected token reaches the guest and can outlive revocation until it expires (spec §8) | the user scopes the token (E8); the operator allowlists only trusted upstreams          | Accepted risk                                                                                                                                                                                               |
| An upstream that echoes request headers into a response body returns the token to the guest (spec §8)                            | `TRACE`/`TRACK` are refused (405), an application-level echo cannot be; same mitigation | Accepted risk                                                                                                                                                                                               |

**Live acceptance, 2026-10-28 (PR #646, single user).** Smoke step 7 on the SBX KVM host, with snapshot `default-p41-ca`, cluster image `main-c10192d`, and a fine-grained PAT on a private test repository. git clone and push, and `/user`, worked from a sandbox with the token injected on the host. The GitHub MCP `initialize` worked with no `Authorization` sent. Deleting the credential gave `401` within the 60 s TTL. The PAT appeared nowhere in the smoke log, and moca-egress's audit carried only the credential name and subject. The host manifest is `~/646-manifest.md`.

## 3. What SBX0 does not claim

- **Defense against a compromised relay.** The worker does not re-verify tokens; a relay that is
  compromised can run anything in any workspace on its workers. That is increment 3.
- **Revocation faster than one token lifetime.** A deleted sandbox, or a removed user, stays
  reachable for up to one token lifetime plus 30 s (15.5 minutes by default).
- **Durability beyond one host.** Losing the KVM host, or its disk, loses every sandbox on it.
- **Isolation once a user re-enables local tools.** If a user turns an agent's built-in tools back
  on (in this repository or in user-level or managed settings, which `mocactl sbx doctor` does not
  read), the agent acts on the laptop.
- **Data protection on the shared host.** Users' code sits on one shared KVM host. The user guide
  says to push internal code only and no secrets; `sbx up` leaves common secret files out, but
  cannot recognize every secret.

## 4. Open items for the reviewer

- **The live acceptance ran 2026-10-20** (spec §10.6), against the deployed namespace with
  workers and janitor on the KVM host. The exact code it used, so the sign-off points at
  reproducible commits: the deployed image was the CI image of `main` at `dc1c25fc`
  (`ghcr.io/rossoctl/moca:main-dc1c25f`), the KVM worker was built from `f5bf7840` (the
  sync fix, PR #562, merged as `920fa884`), and steps 1–4 and 6 ran the smoke harness of
  that same `main` (the sync-fix branch changed only the Go worker, not the harness).
  Step 5's Claude Code half ran green in a re-run of that step alone, with the harness at
  `6aedba08` (the smoke harness fix, PR #564 — headless claude ignored the workspace allow
  in an untrusted repository, so the allow moved to the CLI; the change touches only the
  claude invocation and no other step). Step 5's OpenCode half was skipped — OpenCode was
  not installed on the acceptance machine — so that half is still pending a first live run.
  **Accepted as a known gap, not a blocker**: the cohort opens with the OpenCode half
  unverified, and the cohort is told so until its first live run. The hand checks above
  (§1.2's deployed profile, §1.4's tokenless Exec and attach, §2's guest network) were done
  at the same run. The live run caught one real defect, now fixed and merged: the Firecracker
  launcher's wrapper let a command ending in `exit` skip the pre-teardown `sync`, losing
  every client put (PR #562, with a new non-KVM regression test and a strengthened KVM
  durability gate). Each live row above records its own result.
- **The P4 gates** behind "no process survives a call" were not re-run for this review; they are
  unchanged by SBX0 and run on the KVM rig.
- **Signing-key rotation** replaces the key outright (`deploy/sbx/RUNBOOK.md` §6): outstanding
  tokens fail within one token lifetime. The two-key form of spec §4.3 is not implemented.
- **The deaf-worker slot hold** (spec §3.6): a wedged worker holds a sandbox's in-flight slot until
  its attach stream drops. An availability limit, not a confidentiality one.

## 5. Reviewer sign-off

| Field    | Entry |
| -------- | ----- |
| Reviewer |       |
| Date     |       |
| Findings |       |
| Decision |       |

## 6. Lease mode, level 1 (SBX0.3): DRAFT

> **Draft: needs the security owner's sign-off.** Nothing in this section is signed off, and §6.5 is
> empty. Lease mode stays off by default: `SBX_MODES_ALLOWED` (the control plane's
> `SH_SANDBOX_MODES_ALLOWED`) defaults to `per-exec`, and the change that adds this draft does not
> change that. The [lease-mode spec](../specs/2026-11-08-sbx-lease-mode-design.md) §8.1 and §11 allow
> `per-exec,lease` only after this section is signed off and live smoke step 8 has passed. Level 2
> (`lease+processes`) needs a section of its own: it is out of scope here and stays off.

**What level 1 is.** A sandbox in mode `lease` keeps its microVM between Execs of that one sandbox,
so the guest's tmpfs (`/tmp`, `/var`) and its page cache last until the lease ends. Every process an
Exec starts still dies when the Exec ends, and each Exec gets a fresh shell. The per-`Exec` claims of
§2 hold unchanged for a `per-exec` sandbox, which stays the default. For a lease sandbox, all of them
hold except "no process survives a call", which becomes "no process survives its Exec" (the
guest's files do survive).

The evidence statuses are §1's. "KVM gate" means a gate in
`remote-worker/internal/vmpool/gates_lease_kvm_test.go` or `gates_lease_pool_kvm_test.go`. These are
manual-only and need `/dev/kvm` and a `lease-v1` snapshot; §6.2 gives their status.

### 6.1 What changes against per-`Exec`, and what bounds it (spec §11)

| Change                                                                                                                                    | Bound                                                                                                                                                                                                                                                                                                                                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                      | Status                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Files in the guest's tmpfs last for the lease, so an injected command can leave a file that a later command uses. The rootfs is read-only | The lease ends at its idle timeout (default 300 s; an owner may set 30 s up to the operator's ceiling, 1800 s by default), its maximum duration (8 h) plus the grace limit (30 min), a `reset` (the MCP tool and `mocactl sbx reset`), a downgrade, or the sandbox's delete. The guest has no network. A lease VM serves one sandbox, workspace key and owner only                       | `TestGateLeaseOneSandbox`, `TestGateLeaseTeardown`, `TestGateLeaseNotice` (KVM gates); smoke step 8: one guest for two commands, the idle restart and its notice, `reset`, the downgrade (`deploy/sbx/smoke.sh`, offline-tested in `deploy/sbx/tests/smoke.test.sh`)                                                                                                          | KVM gates: §6.2. Step 8: offline-tested only; **live run pending**                                           |
| An agent could try to raise the mode                                                                                                      | No MCP tool changes the mode: the tools are `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `sandbox_info` and `reset`, and `reset` can only lower what survives. A mode change needs the owner's user API token, which the MCP server does not give the harness. `mocactl sbx create --mode lease` and `mocactl sbx mode` refuse an upgrade without a terminal on stdin (exit 2) | `packages/mocactl/test/sbx-mode.test.ts` "create --mode lease or lease+processes refused without a TTY (exit 2)", "mode upgrade refused without a TTY; downgrade allowed"; `packages/control-plane/test/sandbox-handlers.test.ts` "lets only the owner change the mode or mint a set-mode token, admins included"                                                             | Tested. **Residual**: see §6.3, the terminal rule                                                            |
| A token minted before a downgrade could keep a higher mode for its remaining lifetime                                                     | The worker refuses an Exec with a lower `mode_epoch` (`stale_mode`). A lost epoch file fails closed to `per-exec`, and only a `set_mode` signed by the control plane restores the mode. The set-mode token has its own `typ`, lives 300 s, and must name the caller's `sbx`, `wrk` and `wsk`. Every refusal of it gets the same `PERMISSION_DENIED` message                              | `TestGateLeaseStaleEpoch` (KVM gate); `packages/sandbox-relay/test/lease-wire.transport.test.ts`; `packages/sandbox-relay/test/lease-control.transport.test.ts` "refuses another sandbox's set-mode token...", "every set-mode token refusal tells the client the same thing", "refuses an expired set-mode token", "refuses a sandbox token presented as the set-mode token" | Tested; KVM gate: §6.2                                                                                       |
| An operator narrowing the policy must reach sandboxes created before                                                                      | Every token mint checks the policy. A lease sandbox whose mode the list no longer names is set to `per-exec` at a new epoch, which ends its live lease at the next Exec, and the change is audited                                                                                                                                                                                       | `packages/control-plane/test/sandbox-handlers.test.ts` "downgrades a lease sandbox to per-exec at epoch+1 once its mode is not allowed..."                                                                                                                                                                                                                                    | Tested                                                                                                       |
| An Exec could tamper with its own teardown (cgroup migration, the guest agent), or leave a process behind                                 | An unprivileged Exec uid with no capabilities and `no_new_privs`, a seccomp filter on `ptrace` and `process_vm_*`, a root-owned cgroup tree, a non-dumpable agent, setuid bits stripped and no user namespaces (spec §3.3). The cgroup kill at each Exec's end, and a fresh shell for each Exec                                                                                          | `TestGateLeasePrivilege`, `TestGateLeaseExecKillsProcesses`, `TestGateLeaseFreshShell` (KVM gates)                                                                                                                                                                                                                                                                            | KVM gates: §6.2                                                                                              |
| Files root wrote in the workspace during a `per-exec` period, seen by the lease's unprivileged uid                                        | The ownership walk at the first lease Exec after root wrote, which follows no symlink and stays on the workspace mount. Every worker writes a `.lease-state/.boot` marker, and a lease-on boot after a lease-off one (or with no marker) assumes root wrote everywhere (ruling P4-R4)                                                                                                    | `TestGateLeaseOwnership` (KVM gate); `remote-worker/internal/vmpool/lease_state_test.go` (the boot marker)                                                                                                                                                                                                                                                                    | Tested (the marker); KVM gate: §6.2                                                                          |
| A long-lived guest could hold a secret                                                                                                    | Nothing secret is written into a lease guest. Tokens never enter any guest (§2), and egress credentials stay on the host (§2.1)                                                                                                                                                                                                                                                          | `TestGateLeaseSecrets` (KVM gate, the lease variant of `TestGateSnapshotHoldsNoSecrets`)                                                                                                                                                                                                                                                                                      | KVM gate: §6.2                                                                                               |
| Memory is charged by measurement, not reserved                                                                                            | Reclaim of the idle-longest lease first, never a busy one for memory, then a `memory-budget` refusal; the host-memory floor, cgroup limits, swap off                                                                                                                                                                                                                                     | `TestGateLeaseReclaim` (KVM gate); E17's squeeze point (spec §10)                                                                                                                                                                                                                                                                                                             | KVM gate: §6.2. E17b's squeeze point is **not run**. An availability bound, not a confidentiality one        |
| Clock drift in a long-lived guest                                                                                                         | Clock correction on every lease Exec                                                                                                                                                                                                                                                                                                                                                     | `remote-worker/internal/guestagent/agent.go` (`shouldSetClock`) and its tests                                                                                                                                                                                                                                                                                                 | By construction                                                                                              |
| A deleted sandbox's guest could outlive the record                                                                                        | `mocactl sbx rm` sends `LeaseControl sandbox_deleted` before the `DELETE` (best-effort, at most 15 s), which ends the lease. The janitor removes the sandbox's lease state file with its workspace (ruling P4-R3)                                                                                                                                                                        | `packages/mocactl/test/sbx-cli.test.ts` (rm); `packages/sandbox-relay/test/lease-control.transport.test.ts` (the op); `deploy/sbx/tests/janitor.test.sh`                                                                                                                                                                                                                      | Tested. **Residual**: see §6.3, a delete without `sandbox_deleted`                                           |
| Lease notices and audit lines                                                                                                             | A notice carries an end reason, a time, a mode and, at level 2, process names; no command text and no token. Every `LeaseControl` writes a `sandbox_lease_control` line, refusals included; every mode change writes `sandbox_mode_changed`. A keepalive is not audited                                                                                                                  | spec §5, §8.1, §8.3; `packages/sandbox-relay/test/lease-control.transport.test.ts`                                                                                                                                                                                                                                                                                            | Tested (the audit lines); by construction (the notice fields, `proto/sandbox/v1/sandbox.proto` `LeaseEvent`) |

Spec §11's two level-2 rows (a process that survives between Execs, and a tracked process that runs
code it loads from the workspace) are out of scope here, because `lease+processes` stays off.

### 6.2 The gates (spec §9)

| Gate                              | Property                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `TestGateLeaseOneSandbox`         | A lease VM never serves a second sandbox, workspace key or owner, and never goes back to the standby pool |
| `TestGateLeaseExecKillsProcesses` | After each Exec nothing it started is alive (`&`, `nohup`, `setsid`, a double fork, a daemon)             |
| `TestGateLeaseFreshShell`         | `export`, `cd`, `alias` and shell functions from one Exec are not visible in the next                     |
| `TestGateLeaseTeardown`           | Each end reason destroys the VM and leaks no cgroup, tap, vsock or jail on the host                       |
| `TestGateLeaseStaleEpoch`         | An older `mode_epoch` is refused; after the epoch file is lost only a signed `set_mode` restores the mode |
| `TestGateLeasePrivilege`          | The privilege attempts of spec §9 fail, and every process the Exec started still dies                     |
| `TestGateLeaseOwnership`          | The ownership walk after a `per-exec` period, without following a symlink                                 |
| `TestGateLeaseNotice`             | Every end reason produces exactly one notice, on the next response and in `sandbox_info`                  |
| `TestGateLeaseReclaim`            | The idle-longest lease goes first, a busy one is never reclaimed for memory, then `memory-budget`         |
| `TestGateLeaseSecrets`            | Nothing secret is written into a lease guest                                                              |

Plan 2 added three more KVM gates: `TestGateLeaseFreePageReporting`, `TestGateLeaseTimeoutKeepsTheLease`
and `TestGateLeaseExecCaps`.

**Status.** The gates exist and are listed as manual-only in the gate inventory
(`remote-worker/internal/vmpool/gates_inventory_test.go`). Plan 2's PR (#763) records them passing
on the KVM rig, at that PR's worker. **They have not been re-run since plans 3 and 4 changed the
worker** (the lease frames; the expiring deadline, `sandbox_deleted`, the status cap and the boot
marker), and this draft did not run them. The reviewer should ask for a re-run at the commit to be
deployed, and record its date and snapshot here.

### 6.3 What level 1 does not claim

- **That nothing persists between commands.** Within one lease, files in `/tmp` and `/var` persist
  by design. A user or agent that needs a clean guest calls `reset`.
- **That the terminal rule stops an agent with a local shell.** `mocactl` refuses an upgrade
  without a terminal on stdin, which stops an agent's plain shell call. A program that opens a
  pseudo-terminal itself (`script`, `expect`, Python's `pty`) passes it, as smoke step 8 does on
  purpose. Its real bound is §3's: an agent whose local tools the user re-enabled acts as the user,
  with the user's `mocactl` login. The rule is a guard against accidents, not a boundary.
- **That every delete ends the lease at once.** A `DELETE /v1/sandboxes/{id}` from another client,
  or an `rm` whose `sandbox_deleted` failed or took over 15 s, leaves the lease to end by its idle
  timeout. No new token can be minted after the delete. A token already issued still reaches the
  sandbox for up to one token lifetime plus 30 s, as for `per-exec` (§3), and each Exec it sends
  restarts the lease's idle clock. So the full bound, from the delete, is the token lifetime plus
  30 s, plus the last Exec's duration, plus the idle timeout (at most the operator's ceiling,
  `SBX_IDLE_CEILING_S`, itself at most 86400 s). `deploy/sbx/setup.sh` refuses, when a lease mode
  is allowed, a janitor wait that does not exceed the token lifetime plus 30 s plus the ceiling (the
  relay cancels an Exec at its token's expiry, so the Exec's duration falls inside the token's
  lifetime), so the janitor does not free the workspace under a lease still live; a lease that ends
  after the janitor removed its state file does not write it back.
- **That every notice arrives.** Lease events are best-effort. A lost one changes no state, and
  `LeaseControl status` (`mocactl sbx get`, `sandbox_info`) still shows the lease.
- **Defense against a compromised relay or worker.** Unchanged from §3.

### 6.4 Open items for the security owner

- **Smoke step 8 has not run live.** It is tested offline only. It needs a deployment that allows
  `lease` and a template whose snapshot advertises `lease-v1`. Because the policy is deployment-wide,
  run it on a test deployment, or list `lease` for the run only (`deploy/sbx/RUNBOOK.md` §13).
- **The KVM gates at the deployed worker** (§6.2).
- **E17b's memory-squeeze point** has not run (spec §10, pass criterion 3).
- **The terminal-rule residual** (§6.3): accept it, or ask for a stronger rule.
- **The delete residual** (§6.3): accept it, or ask the control plane to end the lease on delete.
- **Turning lease on is a separate change** after sign-off: `SBX_MODES_ALLOWED=per-exec,lease` and a
  re-run of `setup.sh` (`deploy/sbx/README.md`).

### 6.5 Security owner sign-off (level 1 only)

| Field    | Entry |
| -------- | ----- |
| Reviewer |       |
| Date     |       |
| Findings |       |
| Decision |       |
