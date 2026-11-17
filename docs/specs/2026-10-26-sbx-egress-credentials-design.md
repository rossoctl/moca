# SBX0.2b — User-scoped egress credentials for `mocactl sbx` microVMs — Design

Version: 1.3 — October 27, 2026 (phase 1 implemented; §4.3 secret placement and setup.sh inputs corrected; §8 adds two accepted risks). 1.2: #624 review rounds 1–2: destinations, headers, resolver seam, presets, MCP; revocation per connection, path-confusion rule
Status: Implemented (phase 1)
Milestone: **SBX0.2b**, increment 2b of [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md)
(§11), registered in [the milestone registry](README.md).
Decision record: [ADR-0046](../adrs/0046-sbx-egress-credentials-owner-lookup.md).
Issue: prerequisite [#623](https://github.com/rossoctl/moca/issues/623) (egress wiring in
`deploy/sbx/install-host.sh`).

Builds on these, reusing them without redesign:

- [P4.1](2026-09-15-p4-1-microvm-egress-transport-design.md) and its 2026-10-21 amendment, as shipped
  in v0.8.0: guest `127.0.0.1:3128` → vsock 1025 → `moca-egress`, connection-bound caller identity,
  the allowlist, resolve-once, the audit line, and the `CredentialPolicy` seam that fails closed.
- [MI1](2026-09-28-moca-multi-user-isolation-design.md) §8.5 items 4–5 and §8.7: interception only
  where a credential applies, upstream verification before a leaf is minted, the `Host` check, header
  overwrite, the interception CA. This spec implements them for the SBX path. It does not implement
  MI1's grants (§6). §9 says what replaces them here.
- [MU1](2026-09-08-multi-user-control-plane-design.md) §6: the `CredentialStore`, envelope encryption
  under `SH_CREDENTIAL_KEK`, the `sandbox-egress` consumer, `destination.hosts`, the `binding`, and the
  `FileCredentialStore` (#348).
- [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md): the `sandbox` route profile, the
  sandbox record (`owner`, `worker`, `wsk`), the janitor's bearer-on-the-API-Route pattern (§8.3), and
  `mocactl sbx`'s own login.
- [Z5](2026-06-19-m13-generalized-credentialed-egress-design.md) / ADR-0006: placeholder swap over a
  forward proxy. This spec adds no new egress design. It connects the existing pieces.

## 1. Problem

v0.8.0 gives `mocactl sbx` microVMs allowlisted egress, but nothing authenticates the traffic.
A guest's `gh`, `curl` and `git` carry the inert placeholder `moca-placeholder`
(`deploy/microvm/build-snapshot.sh:567-568`, git helper `:594`), and nothing on the host replaces it.
`moca-egress` installs `NoCredentials{}` (`remote-worker/internal/egress/config.go:90`). A user
therefore cannot clone a private repository, push a branch, open a PR or call an internal API as
themselves from a sandbox.

The user's token must **not** enter the guest. A coding agent runs model-authored code, and a
compromised agent must not be able to read the token, print it or exfiltrate it. The guest keeps the
placeholder, and the host swaps it at egress.

### 1.1 Current state (`rossoctl/main` @ `b8a94b4`)

- **Store.** `CredentialStore` with file, Vault and Kubernetes backends
  (`packages/control-plane/src/main.ts:285-329`). Descriptors carry `consumer`
  (`inference | sandbox-egress | control-plane`), `destination.hosts` and `binding {header, format}`
  (`credential-store.ts:13-111`). The `basic` kind's default binding is
  `Authorization: Basic {base64(username:password)}` (`:171`). Nothing delivers a
  `sandbox-egress` credential today.
- **The sandbox profile has no store.** It wires `UnavailableCredentialStore` (`main.ts:386`) and
  does not mount `/v1/credentials` (`routes.ts:203-226`, profile `HARNESS`). This follows SBX0 §4.1.
  Its pod has no service-account token (`deploy/k8s/overlays/ocp-sbx/patch-control-plane.yaml:12`).
  Its NetworkPolicy allows Redis and public 443 only, and `deploy/sbx/tests/overlay.test.sh:155-164`
  tests that.
- **`mocactl`.** `mocactl credentials add|delete` and the list command talk to the **MOCA** control
  plane (`packages/mocactl/src/cli.ts:42-45`, `headless.ts:544-600`). `mocactl sbx` has its own login
  and control-plane URL (`sbx/cli.ts:117-180`) and no credentials command.
- **`moca-egress`.** It identifies callers from the accepting listener, `Caller{VMID, SessionID,
Subject}` (`internal/egress/identity.go:10`), where `SessionID` is `Register.sid`. For an SBX VM that
  is the `workspace_key` (`vmpool/launcher_firecracker.go:425`, `req.Key`), which equals the sandbox id
  (SBX0 §4.3, `wsk = sbx`; relay check `sandbox-relay/src/sandbox-caller.ts:260`). `Subject` is empty.
  `handler.go:202` asks `Credentials.Intercept(caller, host)` after the allowlist and address checks
  and answers `503 credential_unavailable` if the answer is yes.
- **Host wiring.** `deploy/sbx/install-host.sh` does not install `moca-egress` at all. The live SBX
  host gets egress from a manual drop-in. Tracked in #623, a prerequisite of this spec.

### 1.2 Acceptance

On an SBX host installed from `main` (#623), by a cohort user who has run only the user guide:

1. `mocactl sbx credentials add github --preset github` (a fine-grained PAT on stdin) stores the
   credential. `mocactl sbx credentials` lists it without its secret.
2. Inside a sandbox, `git clone`, `git push` (a branch) and `gh pr create` work against a private
   repository the PAT can reach. `gh api user` returns the user's login.
3. A **second** user's sandbox on the same host, with no credential, gets a public clone tunnelled
   unauthenticated and a `401` from `gh api user`. It never gets the first user's identity.
4. In the guest, after a successful authenticated push, the PAT is absent from the environment, from
   every file under `/` and from `/proc/*/mem` (P4.1 §10's gate, run as a scan for the token's value).
5. Sent **directly** to `api.github.com` from outside, the placeholder `moca-placeholder` gets `401`
   (P4.1 §10, "the placeholder is inert").
6. Deleting the credential stops injection within `SH_EGRESS_CREDENTIAL_TTL_SECONDS` (default 60 s):
   no request sent after that carries it. A response already in flight is not cut (§5.2).
7. `moca-egress` audits each injected request with the credential's **name**, never its value. The
   control plane writes one `egress_credential_issued` audit entry per lookup.
8. The egress-conformance suite (`remote-worker/egress/conformance`) passes with the new
   interception cases (§10.2), and the existing 13 cases still pass.

## 2. Decision summary

| #       | Decision                                | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E1**  | Where the token lives at use time       | **Only in `moca-egress` memory**, cached for at most `SH_EGRESS_CREDENTIAL_TTL_SECONDS`. The guest keeps the image-shipped placeholder (MI1 D7, P4.1 T5).                                                                                                                                                                                                                                                                                                                                                                                 |
| **E2**  | How it reaches the wire                 | **TLS interception in `moca-egress`, only for host:port pairs the caller's owner has a credential for**, then the credential's headers (one or more) are **set**, overwriting whatever the guest sent (MI1 §8.5 items 4–5). All other allowlisted hosts stay opaque CONNECT tunnels.                                                                                                                                                                                                                                                      |
| **E3**  | How the proxy learns whose credential   | **Phase 1: owner lookup.** `moca-egress` sends `(sandbox id, host)` to the control plane, authenticated as its KVM host. The control plane maps the sandbox to its owner and returns that owner's matching credential. **Phase 2 (owed, §9):** the user's sandbox token rides each `Exec` to the proxy, and the control plane releases a credential only against it.                                                                                                                                                                      |
| **E4**  | Bounding the phase-1 lookup             | Each KVM host has its **own** egress token. The control plane answers only for sandboxes whose `worker` is one of that host's workers. A stolen token reaches only the live sandboxes **on that host**.                                                                                                                                                                                                                                                                                                                                   |
| **E5**  | Store                                   | **`FileCredentialStore`** on a PVC in the SBX namespace, sealed under a new `SH_CREDENTIAL_KEK`. **Vault is a follow-up** with no code change (`SH_CREDENTIAL_STORE=vault`). The Kubernetes store is not used, because the sandbox control plane has no Kubernetes API access, and that absence is a tested property.                                                                                                                                                                                                                     |
| **E6**  | Who manages credentials                 | The user, with **`mocactl sbx credentials`** on the sandbox control plane, which now mounts `/v1/credentials` for the `sandbox-egress` consumer only.                                                                                                                                                                                                                                                                                                                                                                                     |
| **E7**  | GitHub's two auth shapes                | **One stored credential**, written by the `github` preset (E12): `basic` kind, `username=x-access-token`, `password=<PAT>`, destinations `github.com` and `api.github.com`. Pending check A0 (§4.4). If A0 fails, the preset writes two credentials from the one PAT. That is a data change, not a schema change.                                                                                                                                                                                                                         |
| **E8**  | Repo- or path-level policy in the proxy | **None.** The user scopes the token, for example a fine-grained PAT limited to chosen repositories. This was the user's decision in design review. Path-scoped credential **selection** (E10) is a different thing: it picks _which_ credential a request carries, never _whether_ the request may go.                                                                                                                                                                                                                                    |
| **E9**  | Interception CA                         | **One CA per KVM host**, generated by `install-host.sh`. The private key goes to `moca-egress` only (`LoadCredential=`). The public certificate is baked into that host's golden snapshot (MI1 §8.7, P4.1 T6). Snapshots are already per host, because restore needs identical hardware.                                                                                                                                                                                                                                                  |
| **E10** | Destination shape                       | **`host[:port][/path-prefix]` entries**, stored as strings in the existing `destination.hosts`, so a bare host is today's entry and no store changes shape. Port defaults to 443 and the prefix to `/`. The lookup answers per `(sandbox, host)` with the owner's **set** of matching entries. `moca-egress` picks per request: same port, then the longest prefix on a `/` boundary. Two of one owner's credentials with an identical destination are refused at `PUT` (`409 destination_conflict`), so ambiguity is a write-time error. |
| **E11** | How a value is produced                 | **A resolver seam** at §4.2 step 4. Phase 1 has one resolver, `static` (decrypt + render). `oauth2-refresh` and `token-exchange` (Z5 E6, §4.1's mint) are later additions behind the **same** lookup contract. Refresh material never leaves the control plane, each returned credential carries `expiresAt`, and `ttlSeconds` is capped by the earliest one. Adding a resolver changes neither the wire nor this ADR.                                                                                                                    |
| **E12** | Presets                                 | **Data, not code.** A reviewed catalog in the repo (`packages/mocactl/src/sbx/presets.ts`, a data-only module) of `{id, description, credentials: [{suffix, kind, destinations, binding, fixed, stdinField}], hint}`, which `--preset` reads and `mocactl sbx credentials presets` lists. `github` and `github-mcp` ship first. An internal MCP gateway or Jira is a data addition.                                                                                                                                                       |

## 3. Request path

```
GUEST                                   │ KVM HOST                                  │ CLUSTER (moca-sbx ns)
                                        │                                           │
 gh / git / curl                        │                                           │
  HTTPS_PROXY=127.0.0.1:3128            │                                           │
  GH_TOKEN=moca-placeholder             │                                           │
  trusts the host's egress CA           │                                           │
      │                                 │                                           │
      └─ CONNECT api.github.com:443 ────▶ moca-egress                               │
         (vsock 1025, per-VM listener)  │  1 caller = listener → (vm, sid=sbx-…)    │
                                        │  2 allowlist, resolve-once, address check │
                                        │  3 lookup(sid, host) ── cache miss ───────▶ POST /v1/egress/credential
                                        │       Bearer <this host's egress token>   │  sandbox sid: live?
                                        │                                           │  worker ∈ this host's?
                                        │                                           │  owner → sandbox-egress
                                        │  ◀── {credentials:[…], ttl} ──────────────│  creds for host
                                        │  4 any on this port → intercept TLS       │  audit egress_credential_issued
                                        │    (host CA leaf), verify upstream first  │
                                        │    none  → opaque tunnel (as v0.8.0)      │
                                        │  5 per request: Host == CONNECT host,     │
                                        │    pick by longest path prefix, set its   │
                                        │    headers, strip                         │
                                        │    Proxy-*/X-Moca-*, stream bodies        │
                                        │  6 audit line + credential name           │
                                        │      │                                    │
                                        │      └──────▶ api.github.com              │
```

## 4. The control plane

### 4.1 Routes on the `sandbox` profile

| Route                                  | Auth                    | Change                                                                                                                                                                                                                                                        |
| -------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/credentials`                  | `api`                   | Profiles `BOTH`. Unchanged handler.                                                                                                                                                                                                                           |
| `PUT /v1/credentials/{name}`           | `api`                   | Profiles `BOTH`. On `sandbox`, a `consumer` other than `sandbox-egress` is refused with `400 invalid_request` naming the profile. The sandbox control plane has no inference or control-plane consumers, and storing one would create a secret nothing reads. |
| `DELETE /v1/credentials/{name}`        | `api`                   | Profiles `BOTH`. Unchanged handler.                                                                                                                                                                                                                           |
| **`POST /v1/egress/credential`** (new) | **`egress`** (new kind) | `SANDBOX` only. The lookup in §4.2.                                                                                                                                                                                                                           |

Every `/v1/credentials` route keeps the `SH_ALLOWED_SUBJECTS` gate that already covers the profile's
`api` routes (SBX0 §4.2). The route-profile test (`route-profile.test.ts`) and the authz enumeration
test are updated to the new membership. They stay allow lists.

The new route lives under `/v1/`, not `/internal/`. Like the janitor's `/v1/janitor/sandboxes`, it is
reached over the public API Route from outside the cluster, and its caller is a host bearer, not a
cluster-internal service.

### 4.2 `POST /v1/egress/credential`

```
Authorization: Bearer <egress token of KVM host H>
{ "sandbox": "sbx-0f3a…", "host": "api.github.com" }

200 { "subject": "github:123", "ttlSeconds": 60,
      "credentials": [
        { "name": "github", "port": 443, "pathPrefix": "/",
          "headers": [ { "name": "Authorization", "value": "Basic eC1h…" } ],
          "expiresAt": null } ] }
404 { "error": "no_credential" }        -- sandbox live and on H, owner has none for host
404 { "error": "sandbox_not_found" }    -- unknown, terminated, or not on H (one code: no oracle)
500 { "error": "destination_ambiguous" } -- two identical destinations: server-side state from a write race (E10)
401                                      -- bad or absent egress token
```

Checks, in order. Each one fails closed:

1. **Caller.** The bearer is compared in constant time against each configured host's token
   (`SH_EGRESS_HOSTS`, §4.3). No match returns `401`. The matching entry names host `H` and its
   worker ids.
2. **Sandbox.** `store.get(sandbox)` returns a record that is **live** (`viewOf(...).state ==
'ready'`) and whose `worker` is in `H.workers`. Anything else returns `404 sandbox_not_found`.
   Not-live and not-on-H share one code, so a host token cannot probe other hosts' sandbox ids.
   The owner must still be enrolled (`SH_ALLOWED_SUBJECTS` or an admin, the gate the refresh path
   applies at `handlers.ts:495`). A removed user's sandbox gets `404 no_credential`, so injection
   stops within one TTL of the removal rather than at the sandbox's expiry. _(Builder's call.)_
3. **Credentials.** List the owner's `sandbox-egress` descriptors and, for each destination entry
   (E10) whose host matches `host` exactly and case-insensitively (no wildcards), emit one element
   `(credential, port, pathPrefix)`. A credential with two entries for this host (two ports, or two
   prefixes) yields two elements. None returns `404 no_credential`. Two elements with the same
   `(port, pathPrefix)` return `500 destination_ambiguous`, never resolved by order (MI1 §6.3 item
   4). It is a 5xx because the request is well formed and the fault is stored state. `PUT` refuses
   that state, so only a write race can reach it. `moca-egress` maps it, like any other unexpected
   answer, to `503 credential_unavailable`.
4. **Resolve and render: the resolver seam (E11).** For each element, the credential's resolver
   produces its header values and an `expiresAt`. The contract above is resolver-neutral. Phase 1
   has one resolver, `static`, which decrypts with `get(owner, name)`, renders, and returns
   `expiresAt: null`. A later `oauth2-refresh` resolver would hold the refresh material in the
   store, refresh on lookup, persist a rotated refresh token, and return the access token's expiry.
   It would never put refresh material on the wire. A `token-exchange` resolver would mint per
   lookup (Z5 §4.1). The `static` resolver renders each binding's `format` server-side: the
   `{field}` substitution and `{base64(a:b)}`. `PUT` today accepts any `{header, format}` for a
   non-inference consumer (`credential-store.ts:270-274`), so for `sandbox-egress` it is narrowed at
   **write time** to formats built only from those two forms over the kind's declared fields, and to
   a header that is not hop-by-hop, `Host`, `Cookie`, `Set-Cookie`, `Proxy-*` or `X-Moca-*`. A stored credential therefore
   always renders. A `sandbox-egress` credential's `binding` may be **one binding or a list of one
   to four**, with header names unique case-insensitively. Each renders to one `headers[]` entry, and
   the write-time rules apply to every entry. The result is ready header values, so the Go proxy has
   no template engine. A value containing CR, LF or NUL is refused (`500 credential_unsafe`,
   CWE-113, as ADR-0026's plugin does).
5. **Audit.** `egress_credential_issued` to `sh:cp:audit` and the stdout mirror (ADR-0044), with
   subject, sandbox id, credential **name**, destination host and egress host `H`. A `no_credential`
   answer is audited as `egress_credential_none`, which is cheap and makes "why was this
   unauthenticated" answerable. A `500 credential_unsafe` or `500 destination_ambiguous` is audited
   as `egress_credential_refused`, with the code as `reason` and the credential names involved.

`ttlSeconds` is the smaller of `SH_EGRESS_CREDENTIAL_TTL_SECONDS` (default 60, range 5–300) and the
seconds left until the earliest non-null `expiresAt`, floored at 5. Rotating or deleting a credential
takes effect within it. **A resolver must never return a value with less than that floor (5 s)
left.** It refreshes it, or omits the element. Otherwise the floor would let `moca-egress` send a
header for up to 5 s after it expired. `static` values never expire, so this binds only later
resolvers. `subject` is for the proxy's audit line only. Identity on the host still
comes from the listener.

**Destination entries (E10), parsed at `PUT` for `sandbox-egress` only.** `host[:port][/prefix]`:
the host as today, a port of 1–65535 (default 443), and a prefix that starts with `/`, contains no
`?`, `#`, `%`, `\`, `//` or dot-segment, and has no trailing `/` except the root (default `/`). The
stored string is normalized: lower-case host, `:443` and a root prefix dropped. Other consumers keep
bare hosts only, exactly as `validateHost` enforces today. A `PUT` whose normalized entry equals an
entry of **another** of the owner's `sandbox-egress` credentials is refused with `409
destination_conflict`, naming the other credential. Nested prefixes (`/` and `/github`) are not a
conflict: the longest wins in `moca-egress`.

The response carries a decrypted secret, so the route answers **only** over the TLS-terminated API
Route and the handler never logs the body. The router's existing body cap applies. The request is two
short strings.

### 4.3 Settings and secrets

| Setting                            | Where                      | Meaning                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SH_CREDENTIAL_STORE=file`         | `patch-control-plane.yaml` | Set on the sandbox profile, no longer deleted.                                                                                                                                                                                                                                                                                               |
| `SH_CREDENTIAL_DIR`                | same                       | `/var/lib/moca/credentials`, a PVC (`moca-sbx-credentials`, RWO, 1 GiB).                                                                                                                                                                                                                                                                     |
| `SH_CREDENTIAL_KEK`                | `sbx-egress` Secret, file  | Generated once by `deploy/sbx/setup.sh` **when credentials are enabled**, kept across re-runs. The `sbx-egress` Secret is separate from `moca-mu1`, labelled `sbx.moca.dev/setup=true`, and projected into `/run/credentials`.                                                                                                               |
| `SH_EGRESS_HOSTS`                  | `sbx-settings` ConfigMap   | JSON `[{id, workers: [...]}]`. Built by `setup.sh` from its `SBX_EGRESS_HOSTS` input (`kvm-a=sbx_default,sbx_py312;kvm-b=w3`; host ids `^[a-z0-9][a-z0-9-]{0,30}$`, every template worker, one listed in `SBX_TEMPLATES_FILE`, owned by exactly one host). When unset, one host `kvm` owns every template worker, which is today's topology. |
| `SH_EGRESS_TOKEN_<ID>`             | `sbx-egress` Secret, files | One 32-byte random bearer per host, generated once. Written into that host's egress bundle (§5.3).                                                                                                                                                                                                                                           |
| `SH_EGRESS_CREDENTIAL_TTL_SECONDS` | `sbx-settings`             | Default 60. Set from the `SBX_EGRESS_CREDENTIAL_TTL_SECONDS` setup.sh input (5-300).                                                                                                                                                                                                                                                         |

**One switch.** `setup.sh` enables the feature only when `SBX_EGRESS_CREDENTIALS=1` is in its env
file. Default is off, so a plain re-run against an existing deployment changes nothing: no KEK, no
PVC, no `Recreate`, no egress bundle. When on, it generates the KEK and the host tokens, applies the
PVC and the overlay's credentials patch, and writes the egress bundles. Turning it off later
unmounts the routes and leaves the PVC and the KEK in place, so turning it back on finds the stored
credentials again. _(Builder's call.)_

The sandbox profile's config loader (`main.ts:168-186`, `sandboxProfileConfig`) gains the KEK, the
store and the egress hosts. It keeps refusing the harness-only settings. The two settings go
**together**. With neither `SH_CREDENTIAL_KEK` nor `SH_EGRESS_HOSTS` set, the profile behaves exactly
as it does today, still wiring `UnavailableCredentialStore` with the four routes unmounted. Exactly
one of them set **fails startup**, naming the other, so a half-applied configuration never mounts
credential routes with nothing to consume them, nor the reverse. `overlay.test.sh` asserts both
shapes.

**Deployment shape.** One replica is already the base (`deploy/k8s/base/control-plane.yaml:33`). The
overlay adds `strategy: Recreate`, because an RWO volume cannot attach to the surge pod of a rolling
update on a multi-node cluster. It also mounts the PVC at `SH_CREDENTIAL_DIR`, since the root
filesystem stays read-only. The NetworkPolicy does not change: the store is local, so the control
plane gains no egress. `automountServiceAccountToken: false` stays, so the "no Kubernetes API" test
still holds.

### 4.4 GitHub's credential shape (E7) and check A0

GitHub reads git-over-HTTPS credentials as `Authorization: Basic base64(x-access-token:<token>)`,
the shape GitHub Actions' checkout uses. For the REST API, GitHub documents a token in place of the
password under Basic auth. One `basic` credential with `username=x-access-token` therefore **should**
cover both hosts with no schema change.

**A0, the first task of the plan, before any other code:** with a fine-grained PAT, `curl -u
x-access-token:$PAT https://api.github.com/user` returns the PAT owner's login, and `git ls-remote`
of a private repository works with the same header. A0 also checks the `github-mcp` preset: GitHub's
remote MCP server at `api.githubcopilot.com` answers an MCP `initialize` POST sent with
`Authorization: Bearer <PAT>`, over `curl --http1.1`, because interception offers HTTP/1.1 only. If A0 fails for `api.github.com`, the `github` preset entry writes two
credentials from the one PAT: `github` (`github.com`, Basic) and `github-api` (`api.github.com`,
`Bearer {password}`). That is a change to the catalog, not to any schema. If the MCP check fails,
`github-mcp` does not ship.

## 5. `moca-egress`

### 5.1 The credential policy

`CredentialPolicy` (`internal/egress/credpolicy.go`) changes from a predicate to a lookup:

```go
type Header struct{ Name, Value string }
type Credential struct {
	Name, PathPrefix, Subject string
	Port                      int
	Headers                   []Header
	ExpiresAt                 time.Time // zero for the static resolver
}
type CredentialPolicy interface {
	// Lookup reports the owner's credential set for c's session at host. Empty means none; an
	// error means unknown, and the caller refuses rather than tunnels.
	Lookup(ctx context.Context, c Caller, host string) ([]Credential, error)
}
```

- `NoCredentials` stays, returning `none`, and is the default. `MOCA_EGRESS_CREDENTIALS_URL` unset
  means v0.8.0 behaviour exactly.
- `controlPlaneCredentials` calls §4.2, with a cache keyed by `(sid, host)` holding found **and**
  none results for `ttlSeconds`, and single-flight per key so a burst of parallel `git` connections
  makes one call. Errors are not cached.
- **Expired elements are dropped.** Any element whose `expiresAt` is non-null and earlier than
  `now + 5 s` (the §4.2 floor) is dropped before the TTL is computed. Dropping is not refusing: the
  rest of the set stands, and a set that is all dropped is an empty set, cached at the 5 s floor.
- **TTL of a `none` answer.** `no_credential` is cached for `MOCA_EGRESS_NONE_TTL_S` (default 60,
  5 to 300). `sandbox_not_found` is cached for the 5 s floor only, so a sandbox that has just become
  ready is not pinned to "none" for a minute. A numeric `ttlSeconds` in a 404 body is honoured,
  clamped to [5, 300].
- **Header grammar.** The client re-checks each element against the control plane's write-time
  rules (`packages/control-plane/src/egress-binding.ts`): names match `^[A-Za-z0-9-]{1,64}$`, none
  is `host`, `connection`, `content-length`, `transfer-encoding`, `te`, `trailer`, `upgrade`,
  `keep-alive`, `cookie` or `set-cookie`, none starts with `proxy-` or `x-moca-`, and none repeats
  within an element. A violation makes the whole response an uncached error.
- `handler.go:202` becomes: no element with the CONNECT port → dial and tunnel (unchanged path); one
  or more → intercept (§5.2);
  error or timeout (`MOCA_EGRESS_CREDENTIALS_TIMEOUT`, default 3 s) → `503 credential_unavailable`,
  as today. **An unreachable control plane never degrades to an unauthenticated tunnel for a host
  that might have a credential.** That is I5, and it is the existing code's behaviour.
- On a **plain-HTTP** (absolute-form) request, any element for the request's port refuses it with
  `403 plaintext_credential` (MI1 §8.5 item 3). A credential is never sent in the clear.
- The lookup happens **after** the allowlist and address checks. Off-allowlist and private
  destinations are refused before the control plane is ever asked.

### 5.2 Interception

MI1 §8.5 items 4–5 and §8.7, restated only where a choice is made here:

- **Before answering CONNECT** (once a `200 Connection Established` is written no status can follow,
  `connect.go:11,20`): lookup, then dial, then a TLS handshake to the upstream, verified against
  system roots plus `MOCA_EGRESS_UPSTREAM_CA` with SNI = the CONNECT host. A verification failure
  answers `502 upstream_unverified` in place of the `200`, and nothing is minted (the suite's deferred
  case, `egress/conformance/doc.go:60-61`). Only then does it answer `200` and serve the guest TLS with a leaf for the CONNECT
  host, minted from the host CA (ECDSA P-256, 24 h, cached in memory per host name). The guest's SNI
  must equal the CONNECT host, else the connection is closed with an audit event.
- **ALPN `http/1.1` only**, toward the guest and toward the upstream. `git`, `gh` and `curl` all speak
  it. HTTP/2 interception is out of scope for phase 1 (§11).
- Each request is read with Go's `http.ReadRequest`. `Host` must equal the CONNECT host, else `421`.
- **Selection (E10).** Among the elements with the CONNECT port, take the one with the longest
  `pathPrefix` that matches the request path on a `/` boundary (`/github` matches `/github` and
  `/github/x`, not `/githubx`).
- **Path confusion.** When **any** element for this host has a prefix other than `/`, a request is
  refused `400 bad_request` with nothing sent upstream if its raw path contains any of: a `.` or
  `..` segment, a `\`, a `;` (matrix or path parameters, which Tomcat, Jetty and Spring strip,
  so `/github/..;/jira` routes to `/jira`), or **any** `%`-escape. That last one covers single
  and double encoding (`%2e`, `%252e`), and is consistent with the prefix syntax, which already
  bans `%` (§4.2). Without the rule, an upstream that normalizes paths could route a credential
  past its prefix: `/github/../jira` would carry the GitHub token to the Jira server behind the same
  gateway. `git`, `gh` and MCP clients do not send these to a gateway. A host whose only prefix is
  `/` has nothing to escape, so the rule does not apply to it. GitHub is that case.
- **No match.** A request that no element matches, on a connection that has never injected for a
  prefix covering it, is forwarded **without injection**. It is still intercepted, with ordinary
  scrubbing only (hop-by-hop headers, `Proxy-*`, `X-Moca-*`). The guest's own `Authorization` passes
  through unchanged: the proxy never invents or removes a credential it does not own.
- **`TRACE` and `TRACK`** on an intercepted connection are refused `405` and nothing is sent
  upstream, because they reflect the request, injected credential included, back to the guest.
- On a match, the guest's own `Authorization` is **removed**, then the selected element's headers
  are each **set**, replacing any value the guest sent and adding
  any it did not send. An uncovered request keeps its `Authorization` (above). So the placeholder never reaches the upstream, and a client that sends no
  `Authorization` at all (an MCP client that would otherwise start OAuth discovery on a `401`) is
  authenticated anyway. `Proxy-*` and `X-Moca-*` are stripped by the existing `forward.go` logic, and
  bodies are streamed. Keep-alive is supported. **Each request re-reads the credential through the
  cache** (no network call while the entry is fresh).
- **Revocation is decided per connection.** A connection remembers every `(pathPrefix, name)` it
  has injected. On each request, every remembered pair whose prefix covers the request path must
  still be in the fresh set. If any is missing, the request is answered `401 credential_revoked`,
  nothing is sent upstream, and the connection is closed. That holds whatever the fresh selection
  would now pick: no element, a shorter prefix, or another name on the same prefix. So a deleted
  `/a` never silently falls back to `/`'s token on a connection that used `/a`. A request path no
  remembered prefix covers is selected afresh (no match means forwarded without injection, as
  above). A long-lived `git` or `gh` connection therefore stops injecting within one TTL of a
  delete, which acceptance item 6 tests. Conformance cases 9 and 10 pin the boundary (§10.2).
- **A response already streaming is not cut on revocation.** Revocation stops the credential being
  _sent_, and an in-flight response sends nothing. A long-lived response, such as the SSE `GET`
  stream of MCP's Streamable HTTP transport, ends on its own schedule, and the next request on that
  connection is refused as above. _(Review of #624; chosen over a watcher that closes streams.)_
- One audit line per request: the existing fields plus `decision: credential_injected`, `credential`
  (the name), `sub` (from the lookup response, for the audit only; identity still comes from the
  listener), and the path with the query stripped (`RedactPath`).

### 5.3 Settings and files

| Setting                              | Source                 | Meaning                                                                                                                                     |
| ------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `MOCA_EGRESS_CREDENTIALS_URL`        | `moca-egress.env`      | The SBX control plane's API URL: scheme and host only, no userinfo, path, query or fragment. Unset leaves credentials off.                  |
| `MOCA_EGRESS_CREDENTIALS_TOKEN_FILE` | `LoadCredential=` file | This host's egress token (`SH_EGRESS_TOKEN_<ID>`). Default `$CREDENTIALS_DIRECTORY/egress-token`. Never an environment variable (MI1 §6.7). |
| `MOCA_EGRESS_CREDENTIALS_CA`         | file, optional         | A PEM CA for the API Route, as the janitor's `SBX_API_CA_FILE`. Default `$CREDENTIALS_DIRECTORY/egress-api-ca.crt` when present.            |
| `MOCA_EGRESS_CA_CERT_FILE`           | `LoadCredential=` file | The interception CA certificate. Default `$CREDENTIALS_DIRECTORY/egress-ca.crt`. It must be currently valid.                                |
| `MOCA_EGRESS_CA_KEY_FILE`            | `LoadCredential=` file | The interception CA key. Default `$CREDENTIALS_DIRECTORY/egress-ca.key`. Readable by `moca-egress` only.                                    |
| `MOCA_EGRESS_UPSTREAM_CA`            | file, optional         | Extra roots for internal upstreams (MI1 §8.5 item 4).                                                                                       |
| `MOCA_EGRESS_CREDENTIALS_TIMEOUT`    | env                    | Default `3s`.                                                                                                                               |
| `MOCA_EGRESS_NONE_TTL_S`             | env                    | How long `no_credential` is cached, in whole seconds. Default `60`, range 5 to 300 (§5.1).                                                  |

Credentials mode is **independent of `MOCA_TENANCY`**, and the boot refusal of `multi` stays. That
refusal guards MI1 S2's grant semantics, which this spec does not implement. Identity is per VM
regardless.

`moca-egress.service` keeps `DynamicUser`, its empty capability set and `ProtectSystem=strict`. It
already dials public upstreams, so reaching the API Route needs no new allowance.

## 6. The guest and the hosts

### 6.1 Snapshot (`deploy/microvm/build-snapshot.sh`)

- A new `--egress-ca PATH` installs the host CA's **public** certificate into the rootfs trust store
  with the distro's own tool, run in the staged tree: `update-ca-certificates` for Debian, Ubuntu and
  Alpine (`/usr/local/share/ca-certificates/moca-egress.crt`), and `update-ca-trust` for the RHEL
  family (`/etc/pki/ca-trust/source/anchors/`). A rootfs with neither tool fails the build, naming
  the flag. It exports `NODE_EXTRA_CA_CERTS` pointing at the **CA file alone** (Node adds it to its
  bundled roots), and `REQUESTS_CA_BUNDLE` and `SSL_CERT_FILE` pointing at the **regenerated system
  bundle** (both replace the roots, so they need the full set). Node and Python clients reaching a
  credentialed host therefore trust the leaf. _(Builder's call: the distro set.)_ Tunnelled hosts present their real certificates, so nothing else
  needs it.
- The placeholder env and the git helper are unchanged (`:567-568`, `:594`).
- `manifest.json` records the CA certificate's SHA-256 fingerprint. `install-host.sh` refuses to pair
  a credentials-enabled `moca-egress` with a snapshot whose fingerprint differs or is absent, naming
  the rebuild command. Without this, a CA rotation or a stale snapshot surfaces as opaque TLS errors
  in the guest.

Nothing unique to a VM or a user enters the snapshot. The CA certificate is the same for every VM on
the host and is a trust anchor, not a secret (P4 §5.2, Z5 E3).

### 6.2 KVM host (`deploy/sbx/install-host.sh`, after #623)

- Generates the host CA once (`$SBX_ENV_DIR/egress/ca.{crt,key}`, key mode 0600, recorded in the
  manifest, kept across re-runs) and installs it through the `moca-egress` unit's
  `LoadCredential=`.
- A new **egress bundle** from `setup.sh` (`.generated/egress/<host id>/`: `egress.env` with the URL,
  plus `egress.token` and an optional `api-ca.crt`) is installed with `--egress BUNDLE_DIR`, mirroring
  `--janitor`, under its own manifest kind.
- `--egress-ca-out PATH` prints where the CA certificate is, for `build-snapshot.sh --egress-ca`.
  Run order on a fresh host: `install-host.sh --egress-ca-out` → `build-snapshot.sh --egress-ca …` →
  `install-host.sh BUNDLE --snapshot …` → `install-host.sh --egress …` (`--egress` needs an installed
  worker's `moca-egress`). On a host with a worker: `--egress` → `build-snapshot.sh --egress-ca …` →
  re-install each worker. `RUNBOOK.md` and the `sbx:install`/`sbx:upgrade` procedures
  carry it.

### 6.3 Internal services and MCP servers

Nothing in the design is specific to GitHub. For an internal REST service, the operator does three
things: allowlist its host, add its range to `MOCA_EGRESS_PERMIT_CIDRS` (P4.1 amendment item 5), and
add its CA to `MOCA_EGRESS_UPSTREAM_CA`. The user then stores a `bearer` or `api-key` credential with
`--host` set to it, or to `host:port/prefix` (E10). A wildcard host (`*.corp.example`) is not
supported in phase 1. Each host is listed.

**An MCP server reached over Streamable HTTP is such a service**, and the main non-GitHub case. Its
transport is HTTP/1.1 `POST` plus an SSE response or `GET` stream, which §5.2 carries unchanged.

- **Several servers behind one gateway** (`mcp.corp.example/github`, `/jira`, `/docs`, each with
  its own token) are path-prefixed destinations: one credential each, selected per request (E10).
- **No placeholder is needed in `.mcp.json`.** The headers are set even when the client sends
  none, so a guest MCP client never sees the `401` that would start OAuth discovery.
- **Two headers** (a key plus a tenant or org header) are a `binding` list (§4.2 step 4).
- **Hour-long OAuth 2.1 access tokens** need the `oauth2-refresh` resolver (E11), which is not
  built in phase 1. Until it is, an MCP server is usable when it accepts a long-lived token, such as
  GitHub's (`github-mcp` preset). The seam is in the contract, so adding the resolver changes
  neither the wire nor `moca-egress`.
- **HTTP/2:** interception offers ALPN `http/1.1` only (§5.2). A hosted MCP server that negotiates
  HTTP/2 still works as long as it still accepts HTTP/1.1, which A0 checks for
  `api.githubcopilot.com` with `curl --http1.1`. The Streamable HTTP transport does not require
  HTTP/1.1, and SSE works over HTTP/2. See §11.

## 7. `mocactl sbx credentials`

```
mocactl sbx credentials [--json]
mocactl sbx credentials presets [--json]                                         # the catalog (E12)
mocactl sbx credentials add NAME --host DEST [--host DEST …] [--kind KIND]       # secret on stdin
mocactl sbx credentials add NAME --preset ID                                     # token on stdin
mocactl sbx credentials delete NAME
```

- These run on the sbx runtime (`sbx/cli.ts`'s `sbxRuntime`, its own login, built with
  `harness: false` at `:142`). `headless.ts`'s `cmdCredentials`, `cmdCredentialAdd` and
  `cmdCredentialDelete` **cannot be called as they are**: each starts with `ready()`, which requires
  `rt.harness` (`headless.ts:249`). Their bodies are factored to take a `cp`-only readiness check (the
  login and API-token validity half of `ready()`), and the `mocactl credentials` commands keep calling
  them through `ready()`. `--consumer` is not offered: the client always sends `sandbox-egress`.
- `DEST` is `host[:port][/prefix]` (E10). The control plane validates and normalizes it.
- **`--preset ID` reads the catalog (E12)**, `packages/mocactl/src/sbx/presets.ts`, a data-only module (no JSON imports exist in mocactl's bundle today), which is
  bundled into `mocactl.mjs` and checked by a schema test. An entry lists one or more credentials,
  each with `kind`, `destinations`, an optional `binding` (one or a list), `fixed` secret fields and
  the one `stdinField`. The preset reads **only that field** from stdin, using the single-line checks
  `secretFromStdin` applies to a one-field kind (`core/credential-checks.ts:159-172`), and fills in
  `fixed` itself. A multi-credential entry writes `NAME` and `NAME-<suffix>` from the one input. The
  first entries are:
  - `github`: `basic`, `github.com` and `api.github.com`, `fixed: {username: x-access-token}`,
    `stdinField: password` (or two credentials if A0 fails, §4.4);
  - `github-mcp`: `bearer` at `api.githubcopilot.com`, `stdinField: token` (ships only if A0's MCP
    check passes).

  Each prints its `hint`. For GitHub that is the reminder to use a **fine-grained PAT scoped to the
  repositories the sandbox needs**, because nothing in MOCA narrows it (E8).

- Against a sandbox control plane that has not enabled credentials (routes unmounted, `404`),
  `mocactl` says that the deployment does not offer egress credentials, rather than "not found".
- The allowlist stays a **host** setting (`moca-egress.env`, written only when absent, #623), and
  the cluster does not learn it. `mocactl` therefore cannot tell a user that a stored credential's
  host is not allowlisted. That case surfaces in the sandbox as `moca-egress`'s named `403
destination_denied`, and `credentials add` prints the hosts it stored so the user can ask the
  operator to allow them. A doctor check against the allowlist is deferred until the allowlist has
  one owner (§11). _(Builder's call.)_
- The agent steering written by `sbx up` (`sbx/agent-config.ts`) gains one line: `GH_TOKEN` in the
  sandbox is a placeholder that the host replaces, so the agent must not try to set or print a
  token.

## 8. Phase 1's accepted risk

The phase-1 lookup authorizes the **host**, not a user action. Whoever holds host `H`'s egress token
can obtain the `sandbox-egress` credentials of **every owner with a live sandbox on `H`**, for as long
as those sandboxes live (SBX0's lifetime, default 7 days). They do not need any user's sandbox token.
The token sits on the KVM host, readable by root and the `moca-egress` unit only.

What bounds it:

- E4: one token per host, answering only for that host's workers. A token stolen from one host
  reaches nothing on another.
- An attacker with root on `H` already controls every VM, workspace and in-flight request on `H`, and
  can read cached credentials from `moca-egress` memory. In phase 1 the token adds **idle** users'
  credentials (live sandbox, no recent use) to that, and lets an attacker use the token from
  **off** the host.
- Every issuance is audited in the control plane with the egress host's id, so off-host use or an
  unusual volume is visible after the fact.
- Users scope their tokens (E8).

Two further risks are accepted, and both are bounded by the user scoping the token (E8) and the
operator allowlisting only trusted upstreams:

- **A `Set-Cookie` minted from the injected token.** An upstream may answer an authenticated request
  with a cookie derived from the token. It reaches the guest, and can outlive revocation until it
  expires. Mitigation: a short-lived or narrowly scoped token, and a trusted-upstream allowlist.
- **An upstream that echoes request headers into a response body** would return the token to the
  guest. `TRACE` and `TRACK` are refused (405), but an application-level echo cannot be detected.
  Mitigation: the same two controls.

This is recorded as an accepted cost in ADR-0046 and is the reason phase 2 exists.

## 9. Phase 2 — the sandbox token as the authorization (owed)

**Goal:** the control plane releases a user's credential only against proof that **that user**
recently authorized work in that sandbox. A stolen host token then yields nothing on its own.

**Shape.** This is MI1 S4's grant wire, carrying SBX0's existing sandbox token instead of a new grant
type:

1. `Exec` gains `bytes grant = 7` (`proto/sandbox/v1/sandbox.proto`), the field MI1 §8.2 reserves.
   `mocactl sbx` and `@moca/sandbox-client` already hold the sandbox token, and the relay already
   verifies it (`sandbox-caller.ts`). The relay forwards the verified token on the `Exec` it sends
   the worker.
2. `microvm-worker` passes the newest token per `workspace_key` to `moca-egress`: on `Register` (the
   field exists, `proto/egress/v1/control.proto`, and is refused when non-empty today) and on
   `Rebind{sid, grant}` (oneof slot 3, reserved for it). It can also verify the token itself with the
   public keys, which is SBX0 increment 3's "worker-side token re-verification".
3. `moca-egress` adds the token to §4.2's request. The control plane verifies it (signature, `typ`,
   `aud = moca-sandbox`, `sbx = sandbox`, `wrk ∈ H.workers`, `exp`) **in addition to** the host bearer
   and caps `ttlSeconds` at the token's remaining life.

**What it buys.** The exposure of a stolen host token drops from "every live sandbox on `H`" to "users
who ran a command on `H` within the sandbox-token lifetime (default 15 minutes)", and becomes zero
with the token alone. User-facing behaviour does not change. The phase-1 routes and settings are kept,
with the token becoming a required field once phase 2 is enabled (`SH_EGRESS_REQUIRE_SANDBOX_TOKEN`).

**Why not now.** It touches the proto, the relay, the worker, the control protocol and token-refresh
handling for long commands. Phase 1 needs none of those to deliver the feature.

**Relation to MI1.** For the SBX path, phase 2 **is** MI1's sandbox grant: the control plane signs
it, the client carries it, and every enforcement point checks it. MI1 S2 still governs the harness's
own sessions, which have a semi-trusted multi-tenant worker that SBX lacks (§12).

## 10. Testing

### 10.1 Control plane (vitest)

- Route membership: the four routes on `sandbox` only when enabled. `route-profile.test.ts` and
  the authz enumeration cover both shapes.
- `PUT` on `sandbox` refuses the `inference` and `control-plane` consumers.
- **Destinations (E10):**
  - Parsing and normalization: `HOST.` and mixed case become `host`, `host:443` becomes `host`,
    `host:443/` becomes `host`, and `host:8443/a/b` is kept.
  - Refused: each forbidden prefix character or form (`?`, `#`, `%`, `\`, `//`, dot-segments, a
    trailing `/`), a port outside 1–65535 or with a leading zero, an IPv6 literal, and more than 16
    entries.
  - Other consumers still accept bare hosts only.
  - `409 destination_conflict` for an identical normalized destination under another name, naming
    it. Nested prefixes are allowed, and re-`PUT` of the same name is allowed.
- **Bindings:** one binding or a list of 1–4. Refused: an empty list, more than 4, and duplicate
  header names (case-insensitive). The narrowing applies to every entry, including `Cookie` and
  `Set-Cookie`. A list renders to `headers[]` in order. A single binding is stored as an object, so
  existing documents compare equal.
- §4.2's matrix:
  - a wrong or absent bearer;
  - a token valid for host A asking about a sandbox on host B (`404`, the same body as an unknown
    id);
  - a terminated sandbox and a deleted sandbox;
  - no match;
  - one host yielding several elements (two ports, or two prefixes), sorted by port, then prefix
    length descending, then prefix string, then name, and a same-length prefix interleaved
    between two duplicates still yields `destination_ambiguous`;
  - `500 destination_ambiguous` from a write race (seeded straight into the store);
  - a case-insensitive host match;
  - `basic`, `bearer` and two-header rendering, and the CR/LF refusal;
  - both audit decisions;
  - no secret value in any log line (spy on stdout).
- **`ttlSeconds`:** a stub resolver returning `expiresAt = now + 20` yields `20`, and
  `expiresAt: null` yields the configured TTL. `staticResolver` always returns `expiresAt: null`. The
  floor is asserted on the clamp alone: an input of 2 s left yields 5.
- Config: the profile is unchanged when neither setting is present; it refuses `SH_EGRESS_HOSTS`
  without a KEK; it refuses malformed `SH_EGRESS_HOSTS`.

### 10.2 `moca-egress` (Go, plus the public conformance suite)

These are the interception cases the shared suite defers (`egress/conformance/doc.go:51-63`), now
implemented. The suite is the contract Cortex must also pass (MI1 S6), so they are added to it, not
to a private SBX group. They follow MI1 §8.5, which this spec does not change: item 4's "intercept
only where a credential applies, tunnel the rest" **is** this spec's `none` → tunnel. The deferred
"`no_credential` answers 401 with zero upstream requests" is realised as case 9 below, the one point
where a host that had a credential no longer has one. `doc.go`'s "`sub` absent (always, in this
slice)" becomes "present on `credential_injected` events". MI1 §12.3's case list gains a pointer to
this section. _(Builder's call.)_

New conformance cases (thirteen), mutation-checked like the existing 13:

1. Credentialed host: the upstream sees the injected header, and never the guest's placeholder.
2. Non-credentialed host: an opaque tunnel, with the upstream seeing the guest's own TLS handshake.
3. Lookup error: `503 credential_unavailable` and no dial.
4. Upstream certificate invalid: `502 upstream_unverified` and no leaf minted.
5. `Host` ≠ CONNECT host inside the tunnel: `421`.
6. Plain HTTP to a credentialed host: `403 plaintext_credential`.
7. Two VMs of different sessions to the same host get different credentials; the cache is keyed by
   sid.
8. Cache: one lookup for N parallel connections; a re-lookup after the TTL; no caching of errors.
9. Revocation mid-connection, per connection (§5.2):
   (a) a connection injects `/a`; the fake drops `/a`, leaving no set at all; the next `/a/x` gets
   `401 credential_revoked`, zero upstream requests, and a closed connection;
   (b) the same, but `/` remains: the next `/a/x` still gets `401`, never `/`'s headers.
10. Path selection and the no-match boundary: with `/` and `/a` credentials on one host, `/a/x`
    carries `/a`'s headers and `/b` carries `/`'s. On a **fresh** connection with only `/a`, `/b` is
    forwarded with nothing injected. On a connection that has injected `/a`, `/b` (not covered by
    `/a`) is forwarded with nothing injected too.
11. Path-confusion refusal: with a path-scoped credential on the host, `/a/../b`, `/a/%2e%2e/b`,
    `/a/%252e%252e/b`, `/a/..;/b`, `/a;x/../b` and `/a\b` each get `400` and zero upstream
    requests. With only a `/` credential, `/a/../b` is forwarded.
12. Several headers: a two-header credential sets both, overwriting the guest's values.
13. Port: a credential for `:8443` does not intercept a CONNECT to `:443`, which is tunnelled.

The test control plane is a fake HTTP server in the harness, so the suite needs no cluster.

### 10.3 Hosts and the snapshot (shell tests)

`install-host.test.sh`: the CA is generated once and kept; egress-bundle install and uninstall; the
fingerprint mismatch refusal. `setup.test.sh`: one egress token per host, kept across re-runs;
`SBX_EGRESS_HOSTS` parsing; the default single host. `overlay.test.sh`: the PVC, `Recreate`, the
store env, the unchanged NetworkPolicy, and no service-account token.

### 10.4 Live (`SBX_LIVE_SMOKE=1`, and the KVM gate)

`deploy/sbx/smoke.sh` gains an opt-in credential step, with a PAT from `SBX_SMOKE_GITHUB_TOKEN`:
§1.2 items 2, 3, 5 and 6. The KVM gate suite gains `TestGateCredentialNeverInGuest` (§1.2 item 4).

## 11. Scope — explicitly not building

- **Vault deployment.** It is a follow-up. The store switch is configuration only
  (`SH_CREDENTIAL_STORE=vault`, `vault-store.ts`). Credentials stored under the file store migrate
  with a one-off copy job, owed with that follow-up.
- **Phase 2** (§9): designed here, not built.
- **Repo-, path- or method-level policy** in the proxy (E8).
- **A single owner for the egress allowlist** (cluster-side, shipped to hosts), and the `sbx doctor`
  check that would need it (§7).
- **HTTP/2 or WebSocket interception.** Clients are offered `http/1.1`. If an upstream (a hosted MCP
  server, say) stops accepting HTTP/1.1, that is the trigger to add HTTP/2 interception.
- **Resolvers other than `static`** (`oauth2-refresh`, `token-exchange`). The seam is designed
  (E11), not built.
- **Named placeholders** (`moca-cred:<name>`, OpenShell-style), so a guest can choose between two
  credentials on one destination without holding either. Destination selection (E10) still bounds
  where each can go. A later addition, with no wire change.
- **Query, path or body placement, and request re-signing.** Credentials go in headers only.
- **Wildcard destination hosts.**
- **SSH** (`git@github.com:`). The tier has no raw sockets (P4.1 §7). `sbx up` already pushes over
  the relay, and users clone over HTTPS.
- **OAuth flows, token minting or GitHub App installation tokens.** The user brings a static token.
  OAuth 2.1 _discovery_ for MCP is not needed, because the headers are set unconditionally (§6.3).
- **Request-signing schemes** (SigV4).
- **The harness's own microVM sessions and the container tier.** These remain MI1 S2, S4 and S5.
- **A cert-pinning escape hatch** (P4.1 §7, unchanged).

## 12. Alternatives considered

- **Give the guest the token** (env or a file): rejected by the requirement in §1. A compromised
  agent reads and exfiltrates it.
- **MI1 S2 grants for SBX:** a second signed token type, a turn-grant exchange and a token endpoint.
  These exist because a P6 worker is semi-trusted and multiplexes users. The SBX path has no such
  worker: the relay verifies the user's sandbox token and the worker is host glue. Phase 2 reuses the
  token SBX already has instead.
- **Carry the sandbox token from day one** (phase 2 now): stronger, and larger, as described in §9.
  It is deferred by decision in design review, recorded as phase 2 in ADR-0046.
- **Kubernetes Secret store:** it would need the sandbox control plane's service-account token and a
  6443 egress rule, undoing a property `overlay.test.sh` asserts and the security review cites.
- **Vault now:** no Vault is deployed. Standing one up (storage, unseal, auth) would dominate the
  slice. It stays the target store.
- **A proxy-side credential store** (secrets on the KVM host): it puts every user's secrets on the
  host whose compromise phase 2 is designed to contain, and needs a second write path from `mocactl`.
- **Cortex/AuthBridge instead of `moca-egress`:** MI1 D4 keeps `moca-egress` until Cortex passes
  the conformance suite (#241).
- **A structured `destination: [{host, port, pathPrefix}]` field** (the #624 review's first shape):
  it would change the stored descriptor in all three stores, the harness profile and `mocactl`'s
  types. The string form `host[:port][/prefix]` in the existing `hosts` array encodes the same
  triple, a bare host parses as `{host}`, and the **wire** to `moca-egress` carries the structured
  form.
- **Per-destination binding overrides on one credential** (`bindings: {host: binding}`): a preset
  can write one credential per destination shape from a single input (§4.4, E12), so the
  descriptor stays one binding or one list.
- **Provider profiles as imported YAML with no compiled registry** (NVIDIA OpenShell): the kind
  registry stays the place for field and validation rules, and the preset catalog (E12) is the data
  layer above it. That is enough while presets are reviewed in this repository.

## 13. Documents amended

- **SBX0 spec:** amendment block. §4.1's "does not mount credentials" no longer holds when this
  increment is enabled. §11 gains row 2b.
- **MI1:** amendment block. For the SBX path, S2's grants are replaced by this spec's phases (§9).
  S4's interception (§8.5 items 4–5, §8.7) is implemented here and will be reused by S4 for the
  harness's sessions. "ADR-0037" in MI1's header and §14 is taken (P6 on Kubernetes). MI1's decision
  record takes the next free number when S2 is written.
- **P4.1:** amendment block. #277's CA and swap acceptance items are discharged by this spec on the
  SBX path.
- **ADR-0042** is refined, not superseded, by ADR-0046. It is not edited (ADR rule 1).
- **Registry** (`docs/specs/README.md`): an SBX0.2b row. MI1's row drops the stale "ADR-0037" pointer.
- **User guide and security review:** a "Credentials" section in `docs/sbx/user-guide.md`. Before
  the cohort uses it, `docs/sbx/security-review.md` gains rows for §1.2 items 3–5 and §8's risk.

## 14. Implementation order (for the plan)

1. A0 (§4.4), a curl check. Its result decides the `github` and `github-mcp` catalog entries.
2. #623: egress on `install-host.sh`.
3. Control plane: profile config, routes, §4.2, tests (§10.1).
4. `moca-egress`: lookup, cache, interception, conformance (§10.2).
5. Snapshot `--egress-ca`, host CA, egress bundle, fingerprint check (§6, §10.3).
6. `mocactl sbx credentials`, the preset catalog, steering (§7).
7. `setup.sh` and the overlay: PVC, KEK, host tokens (§4.3).
8. Live smoke and the KVM gate (§10.4), then the user guide and security review rows.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
