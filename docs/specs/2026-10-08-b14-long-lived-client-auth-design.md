# B14 — Long-lived client authentication: rotating refresh tokens for `mocactl` — Design

**Date:** 2026-10-08 · **Status:** Proposed · **ADR:** [ADR-0039](../adrs/0039-rotating-refresh-tokens.md) ·
**Issue:** [#395](https://github.com/rossoctl/moca/issues/395) (epic #378, item B14)
**Builds on (reuse, no redesign):** [ADR-0033](../adrs/0033-multi-user-control-plane.md) /
[multi-user-control-plane-design](2026-09-08-multi-user-control-plane-design.md) (MU1: device-flow
login, the Ed25519 API token, the `sh:cp:` keyspace and audit stream);
[moca-multi-user-isolation-design](2026-09-28-moca-multi-user-isolation-design.md) (MI1 §6: grants,
the RFC 8693-shaped token endpoint, "short lifetimes, no revocation list");
[ADR-0036](../adrs/0036-tui-decoupled-http-client.md) /
[mocactl-control-plane-client-design](2026-09-25-mocactl-control-plane-client-design.md) (`mocactl`,
its `auth.json` cache).

## 1. Problem

After a night away, the Claude Code hook and `mocactl` must reattach without an interactive login,
and the credential that lets them do so must be revocable.

Today (`rossoctl/main` @ `6831e9d`):

- `POST /v1/auth/device/token` (`packages/control-plane/src/handlers.ts:322`) returns one Ed25519 JWT
  with `scope: ["api"]`, lifetime `SH_API_TOKEN_TTL_SECONDS` (default 3600,
  `packages/control-plane/src/main.ts:92`). There is no refresh token.
- Only the control plane verifies that token (`packages/control-plane/src/server.ts:66`,
  `requiredScope: 'api'`); the data plane sees only session tokens.
- `mocactl` caches it in `$XDG_CONFIG_HOME/mocactl/auth.json`, mode 0600, via temp file and rename
  (`packages/mocactl/src/config.ts:127-160`). When `apiTokenValid` (`core/auth.ts:84`) is false, the TUI
  shows the login screen (`app.tsx:74`) and headless mode refuses (`headless.ts:99`).
- Nothing is revocable: tokens carry a `jti`, but no server-side state is kept for any client token.

### Acceptance (from #395)

1. After 12 h asleep, the hook reattaches without an interactive login.
2. A revoked token is refused.
3. Refresh events are audited.

## 2. Decision summary

- **A rotating, opaque refresh token** issued at device-flow login, exchanged at
  `POST /v1/auth/token` (`grant_type=refresh_token`, RFC 6749 §6-shaped) for a new API token **and** a new
  refresh token. Presenting a superseded refresh token outside a short grace window revokes the whole
  login ("family") — the OAuth 2.1 / BCP for public clients.
- **API tokens stay stateless** and drop to **15 minutes** (`SH_API_TOKEN_TTL_SECONDS` default 900).
  Revocation therefore takes effect at the next refresh, within 15 minutes. No `jti` check is added on
  API requests (decided: a 15-minute revocation latency is acceptable).
- **Login lifetime:** a family dies after **30 days idle** or **90 days absolute**, whichever is first.
- **Revocation:** `mocactl logout` (this login) and `mocactl logout --all` (every login of the
  caller). No operator surface in this slice.
- **Every refresh outcome is audited** to `sh:cp:audit`, atomically with the state change.
- **The hook's contract is `mocactl auth token`**, which prints a valid API token or exits with a
  named code. The hook never reads `auth.json`.

### 2.1 Why this does not contradict MU1 §5.5 and MI1 §6.2

MI1 §6.2 builds "no revocation list; short lifetimes do that job" for **turn grants**; MU1 §5.5 says
offline runs "need no refresh token" because the control plane mints session tokens for a stored
owner. Both remain true: neither path involves a client credential. The refresh family is the one
credential that must live for weeks on an end-user device, so it is the one place revocation state is
kept — and it is consulted only on refresh, never per request. The 15-minute stateless API token is
MI1's own principle (short lifetime bounds revocation latency) applied to the client tier.

## 3. Alternatives considered

| Option                                                 | Verdict                                                                                                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Rotating opaque refresh token + reuse detection** | **Chosen.** Only option that detects a copied `auth.json`. Cost: concurrent refreshers, handled by a client lock (§5.2) and a server grace window (§4.3)                                      |
| B. Non-rotating per-device refresh token               | Simpler, no races; a stolen copy works silently until idle/absolute expiry or manual revocation                                                                                               |
| C. Long-lived JWT client token, `jti` checked on use   | B in a JWT costume: revocation needs the lookup anyway, so the signature adds nothing, and it invites confusion with the API token (a verifier that skips the lookup accepts a revoked token) |
| `jti` denylist on every API request (immediate revoke) | Rejected for this slice: a Redis read on every API call, and every route fails closed when Redis is down. 15-minute latency accepted                                                          |
| Re-verify the GitHub identity on refresh               | Out of scope: device flow has no GitHub refresh grant for MU1's OAuth app; the 90-day absolute cap forces periodic re-attestation instead                                                     |

## 4. Control plane

### 4.1 Token wire format

`mrt_` + base64url(32 random bytes). The prefix lets secret scanners match it. The server stores only
`sha256(token)` (hex): a 256-bit random secret needs no slow hash.

### 4.2 Redis keyspace (beside `sh:cp:session:*`)

| Key                                  | Type   | Fields / members                                                                                                             | TTL                                                                                                                               |
| ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `sh:cp:refresh:family:<fid>`         | hash   | `subject`, `displayName`, `label`, `createdAt`, `absExp`, `idleExp`, `currentHash`, `prevHash`, `revokedAt`, `revokedReason` | `min(idleExp, absExp)`                                                                                                            |
| `sh:cp:refresh:token:<sha256>`       | string | `<fid>`                                                                                                                      | the family's remaining TTL when written                                                                                           |
| `sh:cp:refresh:grace:<fid>`          | string | the plaintext successor of `prevHash`                                                                                        | the grace window (PX)                                                                                                             |
| `sh:cp:owner:<subjectHash>:families` | zset   | `<fid>` scored by the family's own `absExp` (never the current policy, so lowering the limit unindexes nothing live)         | until its latest member's `absExp`, reset on each login; members at or past their `absExp` pruned on login, dangling ones on read |

- `fid` is a random UUID. `label` is a client-supplied hint (`mocactl` sends the hostname), capped at 64
  characters, and never trusted for anything. Nothing reads it back yet: it is stored for the
  device-listing surface §8 defers.
- The grace key holds the **plaintext** successor so a retried request can be answered identically
  (§4.3). It is a separate key with a `PX` of the grace window, so Redis drops it after 30 s: the
  successor is the family's _current_ token, and keeping it in the family hash would leave a usable
  credential at rest for the whole idle limit, undoing the hashing.
- Every key is built from a prefix, `sh:cp:` by default (giving `sh:cp:audit` for the audit stream).
  The real-Redis conformance suite passes a unique prefix so it runs isolated in a shared Redis.
- Token keys are **never deleted**, only expired: each is written with the family's remaining TTL at
  that moment. Revoking a family sets `revokedAt` and nothing else, so a later replay of any of its
  tokens is recognised as `revoked` or reuse, not `unknown`. An active family accumulates at most one
  key per refresh (one per 15 minutes of use), each gone within the idle limit.
- Redis is ephemeral; wiping it logs every client out. That fails safe and matches the ownership
  index's own reasoning (`ownership.ts:5`).
- **Roles are not stored.** Each refresh recomputes them with `rolesFor(subject, adminSubjects)`
  (`identity.ts:52`), so removing someone from `SH_ADMIN_SUBJECTS` takes effect within 15 minutes.

### 4.3 Rotation semantics

`POST /v1/auth/token`, `auth: 'none'` (the refresh token is the credential), body
`{ grant_type: "refresh_token", refresh_token }`. Checks, in order:

1. Hash unknown → `invalid_grant` (400, a new `CP_ERROR_CODES` entry), audited `refresh_refused` / `unknown` (subject `-`).
2. Family `revokedAt` set → `invalid_grant`, audited `refresh_refused` / `revoked`.
3. `now ≥ absExp` → `invalid_grant`, `refresh_refused` / `abs_expired`; `now ≥ idleExp` →
   `refresh_refused` / `idle_expired`.
4. Hash equals `prevHash` and the grace key exists → **return the same successor** with a freshly
   minted API token; audited `refresh_rotated` with `reason: grace_replay`. No state change.
5. Hash equals `prevHash` outside the window, or any older token of the family → **revoke the family**
   (`revokedReason: reuse`), audited `refresh_reuse_detected`; respond `invalid_grant`.
6. Hash equals `currentHash` → rotate: new token `T'`; `prevHash ← currentHash`,
   grace key `← T'` with `PX grace`, `currentHash ← sha256(T')`,
   `idleExp ← min(now + idle, absExp)`; refresh the key TTLs; audited `refresh_rotated`.

"Any older token" in step 5 is detected because a superseded token's key `sh:cp:refresh:token:<h>` is
kept, still mapping to `fid` (§4.2); only the family's `currentHash`/`prevHash` distinguish current
from stale.

Response (200):

```json
{
  "token": "<api jwt>",
  "expiresAt": 1791000900,
  "refreshToken": "mrt_…",
  "refreshExpiresAt": 1798776000,
  "subject": "github:1234",
  "displayName": "Alice",
  "roles": []
}
```

`refreshExpiresAt` is `absExp`. The device-flow response (`completeDeviceAuth`) gains the same two
fields and creates the family (audited `refresh_issued`).

**Atomicity.** Steps 1–6, including the audit `XADD`, run as **one Lua script** (`EVAL`), so a crash or
a concurrent request can never rotate without auditing, audit without rotating, or let two callers
both win step 6. The API token is minted in TypeScript after the script returns (signing needs the
private key). If minting fails after a successful rotation, the client retries inside the grace window
and step 4 answers it.

**Structure.** A `RefreshStore` interface (`issue`, `rotate`, `revoke`, `revokeAllFor`) with:

- `RedisRefreshStore` — the Lua scripts, behind the same `guard()` → `redis_unavailable` (503) mapping
  `OwnershipIndex` uses; it takes its own narrow `RefreshRedisLike` (`get`, `eval`, `zRange`), not
  `CpRedisLike`, whose in-memory fake cannot run Lua.
- `MemoryRefreshStore` — the same semantics in TypeScript, for handler tests. A shared conformance
  suite runs against both; the Redis run needs Redis at 6379, as `work-queue`'s tests do and as CI's
  `redis:7` service provides.

### 4.4 Revocation routes

| Route                      | Auth   | Body        | Effect                                                                                                                                               |
| -------------------------- | ------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/auth/revoke`     | `none` | `{ token }` | Revokes the family the refresh token belongs to (RFC 7009-shaped: always 200, even if unknown). Audited `refresh_revoked` / `logout` when it matched |
| `POST /v1/auth/revoke-all` | `api`  | —           | Revokes every family of the caller's subject. Audited `refresh_revoked` / `logout_all`, one entry per family                                         |

All four auth routes enter the route table (`routes.ts`), the authz enumeration test and
`docs/api/openapi.yaml`, so the drift test covers them.

### 4.5 Audit

Decisions appended to `sh:cp:audit`, each with `subject` and a new optional field `family` (the
`fid`, never a token or hash): `refresh_issued`, `refresh_rotated` (`reason: grace_replay` when step 4),
`refresh_refused` (`reason`: `unknown` | `revoked` | `idle_expired` | `abs_expired`),
`refresh_reuse_detected`, `refresh_revoked` (`reason`: `logout` | `logout_all`).

The one exception is `refresh_refused` / `unknown`: a token nobody issued names no family and no
principal, and anyone can send one, because the route takes no auth. Those go to a separate
stream, `sh:cp:audit:anon`, trimmed to about 100,000 entries. Every write to `sh:cp:audit` trims
it to about 1,000,000 (`MAXLEN ~`). Keeping the anonymous refusals out of it means unauthenticated
traffic cannot trim away the history of real principals (review of #467).

Unlike credential audit (best-effort, `handlers.ts:175-201`), refresh audit is **not** best-effort: it
is written inside the same script as the state change, so if Redis cannot take it, the refresh fails
503 and nothing changes.

### 4.6 Configuration

| Variable                         | Default            | Notes                                                      |
| -------------------------------- | ------------------ | ---------------------------------------------------------- |
| `SH_API_TOKEN_TTL_SECONDS`       | **900** (was 3600) | lifetime of every API token                                |
| `SH_REFRESH_IDLE_TTL_SECONDS`    | 2592000 (30 d)     | idle limit of a family                                     |
| `SH_REFRESH_MAX_TTL_SECONDS`     | 7776000 (90 d)     | absolute limit; must be ≥ idle (refused at boot otherwise) |
| `SH_REFRESH_REUSE_GRACE_SECONDS` | 30                 | retry window for the previous token; 1–300                 |

None is a secret. The implementation plan carries a pre-flight table of every launcher whose
environment changes: `deploy/vm/env/control-plane.env.example`, `deploy/compose/docker-compose.yml`,
the `deploy/k8s` manifests, and any script that reads `expiresAt` assuming one hour.

## 5. `mocactl`

### 5.1 Storage

`CachedAuth` (`config.ts:136`) gains `refreshToken?: string` and `refreshExpiresAt?: number`. The file
keeps mode 0600 and the temp-then-rename write. A cache without `refreshToken` (written by an older
`mocactl`) behaves as today: the user logs in once more.

### 5.2 `ensureAuth()` — the only way a command obtains an API token

In `core/auth.ts`:

1. Cached API token valid for more than 60 s → return it.
2. Take `auth.json.lock` (`open(O_CREAT|O_EXCL)`, containing pid and timestamp; a lock older than 30 s
   is broken). Wait up to 10 s for a held lock.
3. Re-read `auth.json`; if another process already refreshed, release and return its token.
4. No `refreshToken` → `login_required`.
5. `POST /v1/auth/token`; on 200 **write the new pair before anything else**, release, return.
   `invalid_grant` → clear `refreshToken` from the cache and return `login_required`. Network failure
   or 503 → `unreachable`, cache untouched.

The `/v1` client, on a 401 from an `api` route, calls `ensureAuth({ force: true })` once and retries the
request once.

Call sites: the TUI login gate (`app.tsx:74`), headless (`headless.ts:99`) and the overlay checks
(`app-overlay.tsx:81`, `:156`) go through `ensureAuth()`. Device flow appears only after
`login_required`.

### 5.3 Commands

- **`mocactl auth token [--json]`** — prints a valid API token, refreshing if needed; never prompts.
  Exit 0 success, **3** login required, **4** control plane unreachable. `--json` prints
  `{ token, expiresAt, subject }`. This is the whole contract for the hook (A4 #383, B11 #396).
- **`mocactl logout`** — `POST /v1/auth/revoke` with the cached refresh token, then deletes
  `auth.json`. If the server is unreachable, deletes the file anyway and warns that the family stays
  valid on the server until it expires or `logout --all` runs.
- **`mocactl logout --all`** — `POST /v1/auth/revoke-all`, then deletes `auth.json`.
- **`mocactl doctor`** — reports whether a refresh token is held and the absolute-expiry date.

## 6. Failure modes

| Case                                             | Behaviour                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Redis down at refresh / revoke                   | 503 `redis_unavailable`; `auth token` exits 4; the cache keeps both tokens                                                      |
| Audit write impossible                           | the script fails, nothing rotates, 503                                                                                          |
| Two local processes refresh at once              | the lock serialises them; if the lock is bypassed (e.g. a network home directory), step 4's grace answers the loser identically |
| `mocactl` crashes after rotation, before writing | retried within the grace window → recovered; later → reuse detected, family revoked, re-login. Rare, fails safe                 |
| Stolen `auth.json` used by an attacker           | whichever of attacker and owner refreshes second triggers reuse detection; the family dies, `refresh_reuse_detected` is audited |
| Signing key rotated                              | unaffected; the refresh token is opaque and the new API token carries the current `kid`                                         |
| Laptop clock skew                                | the server decides expiry; the 60 s margin plus the one 401 retry covers drift                                                  |
| User removed from `SH_ADMIN_SUBJECTS`            | the next refresh mints without `admin`, within 15 minutes                                                                       |

## 7. Testing

**Control plane**

- `RefreshStore` conformance suite, run against `MemoryRefreshStore` and (Redis at 6379)
  `RedisRefreshStore`: issue; rotate; grace replay returns the identical successor; replay after grace
  revokes; replay of a two-generations-old token revokes; idle expiry; absolute expiry caps idle
  extension; revoke; revoke-all leaves another subject's families intact; every outcome writes exactly
  one audit entry of the right decision; key TTLs are set.
- Handlers with an injected clock: device-flow login returns a refresh token; `/v1/auth/token` mints a
  900 s API token whose roles reflect the current `adminSubjects`; `invalid_grant` shapes; revoke
  routes.
- The authz enumeration and OpenAPI drift tests cover the four routes.
- `configFromEnv`: new variables, defaults, max < idle refused.

**mocactl**

- `ensureAuth` against a fake control plane: valid token untouched; refresh; `invalid_grant` →
  `login_required` with `refreshToken` cleared; 401 → forced refresh and one retry.
- Two concurrent `ensureAuth` calls make exactly one network refresh; a stale lock is broken.
- `auth.json` is mode 0600 after rotation.
- `auth token` exit codes 0/3/4 and `--json` shape; `logout` and `logout --all` call the right routes
  and delete the file.

**Acceptance, each with a test**

1. _12 h asleep:_ clock advanced 12 h past login, `mocactl auth token` succeeds with no device flow.
2. _Revoked token refused:_ after `logout`, the saved refresh token gets `invalid_grant`; after reuse
   detection, so does the current one.
3. _Refresh audited:_ each rotation appends one `refresh_rotated` entry naming subject and family.

## 8. Scope — explicitly not building

- An operator command to revoke another subject's families, or to list devices.
- Re-verifying the GitHub identity on refresh (the 90-day cap stands in for it).
- `jti` revocation of API tokens.
- The hook itself (A4 #383, B11 #396 consume `mocactl auth token`).
- A browser authorization-code flow (MU2).

## 9. Ordering

#395 is listed "after B2" (#387). This design touches none of B2's routes or records, so it is built
from `rossoctl/main` independently; either may merge first.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
