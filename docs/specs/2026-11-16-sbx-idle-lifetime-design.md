# SBX0 — A sandbox's lifetime counts idle time, not time since creation — Design

Version: 0.1 — November 16, 2026 (draft for review)
Status: Design. Approved (2026-11-16). Not built.
Milestone: **Idle lifetime**, an increment of
[SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md), registered in
[the milestone registry](README.md).
Decision record: a 2026-11-16 revision of
[ADR-0042](../adrs/0042-sbx0-sandbox-service-on-sandbox-v1.md), which replaces its "fixed absolute
lifetime" (§10).
Issue: rossoctl/moca#770.

Builds on these, reusing them without redesign:

- [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md): the sandbox record and its computed
  expiry (§5.2), the invariants that remove the silent reset (§5.4), the Redis store (§5.5), the
  per-sandbox token (§4) and the janitor (§8.3).
- [SBX0.3](2026-11-08-sbx-lease-mode-design.md): the set-mode token (§8.2). Its `idleTimeoutS` (how
  long a lease guest stays warm between Execs) is a different thing from this design's
  `idleLifetimeS` and is not touched (§9).

## 1. Problem

A key cohort user works in the same sandbox every day. Their concern is losing data. Today a sandbox
ends 7 days after it was created whatever its use: `expiresAt` is set once at create
(`sandbox-handlers.ts`, `now + cfg.lifetimeS`), nothing moves it, and at the deadline the record
reads `terminated / expired` and the mint refuses. A user who works in a sandbox daily for a week
loses its workspace at the 7-day mark although it was never idle.

The absolute lifetime is right for an abandoned sandbox: it is what bounds disk and worker capacity.
It is wrong for one in use.

### 1.1 Current state (`rossoctl/main` @ `fb9d839b`)

- `SH_SANDBOX_LIFETIME_SECONDS` (default 7 days; `setup.sh`'s `SBX_LIFETIME_DAYS`, 1–30) is the
  absolute lifetime (`sandbox-config.ts`).
- `expiresAt` is stored in three places in Redis (`sandbox-redis.ts`): the record hash's field, the
  `sbx:live` score, and — through retention — the record hash's own `EXPIREAT` (`expiresAt +
retention`) and the name key's `PXAT` (same instant, in ms).
- Every SBX0 worker's `SH_WORKSPACE_IDLE` is `SBX_LIFETIME_DAYS × 24 + 48` hours (216 h), written
  by `setup.sh` into each worker bundle. Changing it needs `install-host.sh` re-run on every host;
  `setup.sh` refuses a change unless `SBX_ACK_HOSTS=1`.
- The janitor frees an unknown workspace directory whose newest mtime is older than its worker's
  `SH_WORKSPACE_IDLE`, on the same reasoning as §5.4.1: no live sandbox can be that stale.
- A sandbox token lives at most `MAX_SANDBOX_TOKEN_TTL_S` = 3600 s (default 900 s), never past the
  sandbox's `expiresAt`; the relay refuses a token more than 30 s past its `exp` and cancels an Exec
  at its token's `exp` (SBX0 §3.6, §5.4.2).
- The lease mode's set-mode token is minted from the same record (`notAfter: rec.expiresAt`).

### 1.2 Acceptance

- A sandbox with activity (§3) inside each lifetime window does not expire, however old it is.
- A sandbox with no activity for its lifetime reads `terminated / expired` and refuses to mint, as
  today.
- The owner can choose a sandbox's lifetime at create, from 1 hour up to the deployment maximum
  (unset, the deployment default; `deploy/sbx/setup.sh` sets 30 days); without a choice it is the deployment default (7 days).
- `expiresAt` on every route reflects the extended deadline.
- The Redis extension is one atomic script, and it refuses an expired or deleted sandbox: an ended
  sandbox is never revived.
- The store contract tests cover the extension and run against both stores.
- No silent reset: the worker's idle reclaim and the janitor's unknown-directory sweep still cannot
  reach a live sandbox's workspace, except in the one case §7 states and accepts.
- ADR-0042 is revised and SBX0 §5.1, §5.2, §5.4 and §5.5 are updated.

## 2. Decision summary

- **Lifetime is idle time.** A sandbox ends after `idleLifetimeS` with no activity. Each activity
  moves `expiresAt` to `max(expiresAt, now + idleLifetimeS)`. It never moves backwards.
- **Activity is a token mint**: the sandbox token (`POST /v1/sandboxes/{id}/token`) and the lease
  set-mode token, unless the client marks the mint `activity: false`. `mocactl` marks the mints that
  run no command (the MCP server's lease keepalive, `sbx get`'s lease status). Reads (`list`,
  `get`), delete and the janitor route are not activity (§3).
- **No hard maximum age.** A sandbox in daily use lives indefinitely. A cap would bring back the
  loss this design removes, and it is not needed for safety (§6). Disk stays bounded by the live
  quotas (SBX0 §5.3) and by idle expiry.
- **The owner chooses the lifetime at create**: `idleLifetimeS`, 3600 s to
  `SH_SANDBOX_MAX_LIFETIME_SECONDS` (unset: the default lifetime; `setup.sh` sets 30 days), default `SH_SANDBOX_LIFETIME_SECONDS` (7
  days). Create only; it cannot be changed later.
- **The worker's idle reclaim follows the maximum**, not the default: `SH_WORKSPACE_IDLE` =
  max + 48 h (768 h for 30 days).
- **Existing records need no migration.** They slide from their next mint, at the default lifetime.

## 3. What counts as activity

**A mint, and only a mint.** The control plane never sees an Exec: Execs go from the client to the
relay to the worker. But every Exec needs a sandbox token the relay accepts, and a token lives at
most 3600 s (+30 s leeway). So every Exec on any day was preceded, within the hour, by a mint on the
control plane. Any day a user does anything in the sandbox — `mocactl sbx exec`, `run`, `push`,
`pull`, `shell`, an MCP tool call — the sandbox's deadline moves that day. The mint is the one
choke point every client goes through, so the deadline slides for every client, older ones included.
The one client change is to stop mints that run no command from counting (§3.1).

The mint routes count:

- `POST /v1/sandboxes/{id}/token` (the sandbox token);
- the lease mode's set-mode token, minted by `PUT /v1/sandboxes/{id}/mode` and
  `POST /v1/sandboxes/{id}/mode-token` (`setModeTokenFor`; lease-mode spec §8.1–§8.2): the owner
  acting on the sandbox.

Not activity:

- `GET /v1/sandboxes` and `GET /v1/sandboxes/{id}`: a dashboard or a status poll must not keep a
  sandbox alive forever;
- `DELETE`: it ends the sandbox;
- `GET /v1/janitor/sandboxes`: not the owner.

### 3.1 Mints that run no command: the `activity` hint

Today's clients mint in two places where no command runs:

- **the MCP server's lease keepalive.** On a lease-mode sandbox `mocactl sbx mcp` sends
  `leaseKeepalive()` every 30 s (`mcp.ts`, `KEEPALIVE_MS`), and each needs a token with 60 s left,
  so it mints about every 14 minutes for as long as the process runs, tool calls or not. The worker
  deliberately does not count a keepalive as use (`vmpool.Keepalive` sets `lastKeepalive`, never
  `lastExec`).
- **`mocactl sbx get` on a lease-mode sandbox**: it opens an exec connection (a mint) for
  LeaseControl `status`, and mints a set-mode token when the worker's epoch is unknown
  (`lease-commands.ts`).

If those mints counted, an idle MCP window would keep a sandbox alive forever, and — worse — at the
30-day maximum a weekend with the window open and no command would let the worker reclaim the
workspace while the control plane still read it live (§7): the silent reset.

So both mint routes take an optional body field, `activity` (boolean, default `true`):

- `POST /v1/sandboxes/{id}/token` and `POST /v1/sandboxes/{id}/mode-token` with
  `{ "activity": false }` mint as today and do not touch the deadline. Anything but a boolean is
  `400 invalid_request`. `PUT /v1/sandboxes/{id}/mode` (an owner's mode change) always counts, and
  refuses a body naming `activity` with `400 invalid_request`, so a client that sends it there
  learns it has no effect rather than getting a silent extension.
- **Default `true`**, so an older `mocactl` and developers' own code (SBX0 §7) still extend. An older
  `mocactl` cannot ask for more than the 7-day default (it has no `--lifetime`), so its sandboxes keep
  the 25-day margin of §7 even with its keepalive counting. Developers' own code can send
  `idleLifetimeS` up to the maximum without ever sending the hint; its margin is then §7's, as low as
  2 days at 30 days.
- **`mocactl` sends `activity: false`** for the keepalive's mints and for `sbx get`'s.
- **A no-activity token never runs a command.** The exec connection records whether its held token
  came from an activity mint. Before an Exec (`exec`, `run`, `push`, `pull`, `shell`, MCP tool
  calls), a token from a no-activity mint is replaced by a fresh activity mint, even if it is still
  valid. Otherwise a session's Execs could keep reusing tokens the keepalive minted, and a day of work
  would not move the deadline. This costs at most one extra mint per token lifetime.

The hint is the client's own say about its own sandbox: a client that lies only keeps its owner's
sandbox alive, within the owner's quota, or lets it expire sooner.

A command that only reads the record (`mocactl sbx ls`, `get` on a per-exec sandbox) does not mint
and does not extend the lifetime. `doctor` does not mint (it reads the record).

## 4. The rule, and where it runs

### 4.1 Create

`POST /v1/sandboxes` takes an optional `idleLifetimeS`:

- a safe integer, `3600 ≤ idleLifetimeS ≤ cfg.maxLifetimeS`; anything else is
  `400 invalid_request` naming the range, as `idleTimeoutS`'s check does;
- absent: `cfg.lifetimeS`.

The record stores it, and `expiresAt = now + idleLifetimeS`.

### 4.2 Extension on mint

In `mintSandboxToken`, after `requireLive` and `underPolicy`, before the token is minted (and in
the same place in the two set-mode token handlers, before `setModeTokenFor`), unless the body says
`activity: false` (which `PUT …/mode` refuses, §3.1):

```
touched = store.touch(id, now, rec.idleLifetimeS ?? cfg.lifetimeS, cfg.retentionS)
if touched is null → 409 sandbox_terminated (reason from a re-read, as requireLive gives it)
mint with notAfter = touched.expiresAt
```

`touch` sets `expiresAt = max(expiresAt, now + L)` and returns the record as written. It refuses
(returns null) a missing, deleted or expired record (`now >= expiresAt`), checked inside the same
atomic step as `markDeleted` and `setMode` check it. A mint racing a delete or the deadline either
extends a live sandbox or refuses; it never revives an ended one.

Because the extension happens before the mint, the token's `exp` is capped by the new deadline.

**The mint response carries the new deadline.** `POST /v1/sandboxes/{id}/token` gains
`sandboxExpiresAt` (additive; `expiresAt` stays the token's `exp`). A long-lived client must track
it: `exec-conn.ts`'s `learn()` treats a token whose `exp` reaches the `sandboxExpiresAt` it was given
as cut short by the sandbox's end, so an `mocactl sbx mcp` started on day 1 would refuse every Exec
as `expiring` once the original deadline passes, though the sandbox is live. Each mint's
`sandboxExpiresAt` replaces the connection's (and the MCP server's, which names the date in its
"expired on" text). An older control plane omits it; the client then keeps today's behavior.

**Old records.** A record without `idleLifetimeS` slides at `cfg.lifetimeS` as it is at mint time.
Its stored `expiresAt` (create + 7 days) only ever moves forward, so nothing is migrated.

### 4.3 The view

The wire `Sandbox` (SBX0 §5.1) gains `idleLifetimeS` (the record's, or `cfg.lifetimeS` for an old
record — never null). `expiresAt` is the current deadline and `terminatedAt` for an expired record
is that deadline, as today. Once a record is past `expiresAt` no write can move it, so
`terminatedAt`, retention (`seal`), the egress grace and the `sandbox_expired` audit record all keep
counting from the true end.

## 5. Storage

### 5.1 The contract

`SandboxStore` gains:

```ts
/**
 * Moves a live sandbox's expiresAt to max(expiresAt, nowS + idleLifetimeS), and its retention with
 * it. Null for a missing, deleted or expired one (nowS >= expiresAt), so an ended sandbox is never
 * revived.
 */
touch(id: string, nowS: number, idleLifetimeS: number, retentionS: number): Promise<SandboxRecord | null>;
```

`MemorySandboxStore` is the contract's reference. `test/helpers/sandbox-store-contract.ts` gains the
cases in §8 and runs against both stores.

### 5.2 Redis: one script

`TOUCH` (KEYS: rec, live, name or the placeholder; ARGV: now, idleLifetimeS, retention, id,
hasName):

1. refuse a missing record, one with `deletedAt`, and one with `now >= expiresAt`;
2. `new = max(expiresAt, now + idleLifetimeS)`; if `new == expiresAt`, return the record unchanged;
3. `HSET rec expiresAt new`;
4. `ZADD live new id`;
5. **`EXPIREAT rec new + retention`** — the record hash's own TTL is `expiresAt + retention`, so
   without this an actively used sandbox's record would be dropped by Redis 21 days after create
   while the sandbox is live;
6. when named and `GET name == id`, `PEXPIREAT name (new + retention) × 1000`, keeping the name
   key's garbage-collection instant in step (SBX0 §5.5);
7. return `HGETALL rec`.

The `owner` and `all` indexes are scored by `createdAt` and do not change.

**The egress log moves with it.** The sandbox's egress log (stream and meta keys, and its score in
the egress expiry index; `egress-log.ts`) gets `EXPIREAT end + retention` only when a host appends
events, from the deadline as it was then. The egress records design promises the log lives "as long
as the sandbox record: its end plus the sandbox retention". So a touch that moves the deadline also
moves those keys' `EXPIREAT` and their index score (`ZADD XX`), when they exist, and leaves a sealed
log alone (a sealed log belongs to an ended sandbox, which a touch refuses). This is done **inside
`TOUCH`**, the stream, meta and index keys passed in KEYS: a second write after it could crash on
the last mint before a sandbox goes idle, and nothing would repair it, so the log would expire at the
old `end + retention` while the record lived to the new one. Every key is in one Redis (none of
`sandbox-redis.ts`'s or `egress-log.ts`'s keys are cluster hash-tagged, and SBX0 runs no Redis
Cluster), so one script can touch both prefixes.

Liveness stays judged from the caller's `now` against the `live` score, so the memory and Redis
stores stay in step under one injected clock.

**Write cost.** One script per mint: a connection mints at most once per token lifetime (15 min by
default), so a few writes per active sandbox per hour. No throttling is needed; the builder may skip
the write when the extension would be under 60 s.

## 6. Settings, the worker's idle reclaim and the janitor

### 6.1 Settings

| Control plane                     | `setup.sh`              | Default                                  | Meaning                                   |
| --------------------------------- | ----------------------- | ---------------------------------------- | ----------------------------------------- |
| `SH_SANDBOX_LIFETIME_SECONDS`     | `SBX_LIFETIME_DAYS`     | 7 days                                   | the default idle lifetime (was: absolute) |
| `SH_SANDBOX_MAX_LIFETIME_SECONDS` | `SBX_MAX_LIFETIME_DAYS` | 30 days (`setup.sh`; unset: the default) | new: the most an owner may set at create  |

- The control plane refuses to start when `SH_SANDBOX_LIFETIME_SECONDS > SH_SANDBOX_MAX_LIFETIME_SECONDS`,
  or when either is under 3600.
- **Unset, `SH_SANDBOX_MAX_LIFETIME_SECONDS` is `SH_SANDBOX_LIFETIME_SECONDS`**, not 30 days: a
  control plane upgraded before `setup.sh` writes the key still runs over workers whose
  `SH_WORKSPACE_IDLE` covers only the old lifetime (216 h), so it must offer nothing longer. The
  30 days are `setup.sh`'s default, written behind its `SBX_ACK_HOSTS` refusal (§6.3).
- `setup.sh`: `SBX_MAX_LIFETIME_DAYS` is 1–30, default 30, and must be at least `SBX_LIFETIME_DAYS`.

### 6.2 The worker's idle reclaim

`SH_WORKSPACE_IDLE` becomes `SBX_MAX_LIFETIME_DAYS × 24 + 48` hours (768 h at the default), and
`setup.sh`'s check becomes `SH_WORKSPACE_IDLE > SH_SANDBOX_MAX_LIFETIME_SECONDS`.

Why the invariant still holds (SBX0 §5.4.1, restated). Both clocks are idle clocks now, though they
do not reset on the same events:

- the worker reclaims a workspace after `max + 48 h` without a reset of its `lastExec`, which an
  Exec's start sets (`acquire`, `pool.go`), as do a lease run's start and end and the lease's own
  end (`lease.go`; lease end includes `keepalive_lost` and the lease idle timeout);
- the control plane ends a sandbox after `L ≤ max` with no mint;
- every Exec is preceded, within one token lifetime (≤ 1 h), by a mint.

Each of the worker's resets happens during or after an Exec, so its last reset is never earlier
than the last Exec's start; a lease end with no new mint only moves the worker's clock later, which
makes it more conservative. So a workspace idle at the worker for `max + 48 h` belongs to a sandbox
with no mint for at least `max + 47 h > L`, which has already ended — except when mints went on without Execs (§7). The
janitor's unknown-directory sweep uses the same `SH_WORKSPACE_IDLE` and the same reasoning, and
needs no change.

### 6.3 Rollout

Raising the maximum from 7 to 30 days changes `SH_WORKSPACE_IDLE` from 216 h to 768 h on every
worker. `setup.sh` refuses that change before applying anything, as it does today, so the operator
runs it with `SBX_ACK_HOSTS=1` and then re-runs `install-host.sh` with the new bundles on every host
right after (the deploy README's existing procedure).

Between the two steps the control plane already accepts a 30-day lifetime while the hosts' workers
still reclaim after 216 h idle. That window is harmless as long as it is short: a sandbox created in
it would have to go 9 days without an Exec before its host is reinstalled. The upgrade runbook says to
reinstall the hosts the same day; `status.sh`'s host check should report a worker whose
`SH_WORKSPACE_IDLE` does not exceed the control plane's maximum.

The deploy README's "Changing `SBX_LIFETIME_DAYS` means reinstalling every host's workers" becomes
"Changing `SBX_MAX_LIFETIME_DAYS`…": changing only `SBX_LIFETIME_DAYS` (within the maximum) no longer
touches the hosts.

## 7. The one remaining gap (accepted)

The worker resets its clock on Execs; the control plane on activity mints. With the hint (§3.1),
every activity mint from `mocactl` is followed by an Exec unless that Exec fails. If activity mints
go on while every Exec fails (the relay unreachable for days, say), or a client of its own (SBX0 §7)
mints without running commands and without the hint, the control plane keeps the sandbox alive while
the worker's clock runs. A silent reset needs `lastMint − lastExec > (max − L) + 48 h`:

- a sandbox at the 7-day default: about 25 days of mints with no Exec reaching the worker;
- a sandbox at the 30-day maximum: 2 days.

This is accepted and documented in the user guide's limits, beside "losing the host". Closing it
would need the relay to report Execs to the control plane, which is out of scope (§11).

## 8. Clients

- `mocactl sbx create` and `mocactl sbx up` take `--lifetime DURATION` (`36h`, `14d`, or seconds),
  sent as `idleLifetimeS`. The control plane holds the range; the client checks only the syntax, as
  `--idle-timeout` does: `--lifetime 30m` reaches the server and its 400 names the range (§4.1).
  `up` sends it only when it creates. When `up` binds an existing sandbox, it warns that the lifetime
  is set only at create and that the sandbox keeps its own (`sbx-… keeps its 7 d lifetime;
--lifetime applies only to a new sandbox`), and goes on; it is not an error.
- `create`, `ls`, `get`, `doctor` and the `sync.ts` binding line keep printing `expires <time>` and
  add the idle lifetime: `expires 2026-11-23T09:00:00Z (after 7 d without use)`. `--json` outputs
  carry `idleLifetimeS`.
- The MCP server's sandbox description (`mcp.ts`) says the sandbox ends after N days without use,
  instead of a fixed date that goes stale as the deadline slides.
- `doctor`'s "less than 24 h left" warning is unchanged: it now means "unused for L − 24 h".
- Clients follow `sandboxExpiresAt` from each mint (§4.2).
- The keepalive and `sbx get`'s lease status mint with `activity: false`, and an Exec never runs on
  a no-activity token (§3.1). The developer docs for the gRPC API (SBX0 §7) document the hint.

The user guide's limits ("Sandboxes expire after 7 days … A sandbox's lifetime cannot be extended")
are rewritten: a sandbox ends after 7 days without use by default, `--lifetime` up to the
deployment's maximum, any command extends it, and §7's gap is stated.

## 9. Naming

- `idleLifetimeS` (record, wire, create body): the sandbox's idle lifetime. Not `lifetimeS`, which
  `mocactl`'s `SandboxTokenGrant` already uses for a token's lifetime.
- `idleTimeoutS` (lease mode) is unchanged: how long a lease guest stays warm between Execs, seconds
  to hours, enforced by the worker. Docs and help text say "lease idle timeout" for it and
  "lifetime" for this, never "idle timeout" for this.

## 10. ADR

ADR-0042 gets a dated revision (2026-11-16), in the shape of ADR-0035's revisions: the lifetime is
idle-based with an owner-chosen value up to a deployment maximum; no extension rule replaces "with no
extension"; the "no silent reset" invariant "the worker's idle reclaim is set longer than any
sandbox can live" becomes "longer than the longest idle lifetime a sandbox can have". SBX0 §5.1,
§5.2, §5.4.1 and §5.5 are updated to point here.

## 11. Scope — explicitly not building

- A hard maximum age, or an `expired` sub-reason (`idle` / `max_age`): there is no maximum age.
- Changing a sandbox's lifetime after create, or a "keep alive" route.
- Activity from the relay (Execs reported to the control plane), which would close §7.
- Extension on reads.
- A migration of existing records.

## 12. Testing

- **Store contract** (both stores): `touch` extends a live sandbox; never moves `expiresAt`
  backwards (a shorter `idleLifetimeS` than the time left is a no-op); returns null for missing,
  deleted and expired (`now == expiresAt` included); a touched sandbox stays live past its original
  deadline for quotas, name uniqueness and `list`; after a touch the sandbox still expires at the new
  deadline.
- **Redis** (real Redis, `test/sandbox-redis.test.ts`): the record hash's TTL, the name key's
  PXAT, and an existing egress log's keys and index score move with the deadline; a touch racing `markDeleted` leaves the record deleted; an old hash
  without `idleLifetimeS` reads as the default.
- **`exec-conn`**: a connection whose sandbox's deadline moved keeps running Execs past the original
  `sandboxExpiresAt`; one without the field behaves as today.
- **Hint** (handlers): `activity: false` mints a token and leaves `expiresAt`, the record's TTL and
  the name key as they were, on both routes; a non-boolean refuses; `PUT …/mode` extends, and
  refuses a body naming `activity` with 400;
  a no-activity mint on an expired sandbox still refuses.
- **`mocactl`**: an MCP server left open with no tool calls on a lease sandbox mints only with
  `activity: false`; the first tool call after a keepalive mint mints again, with activity; `sbx get`
  on a lease sandbox sends the hint.
- **Handlers** (injected clock): mints every 6 days keep a 7-day sandbox alive for 60 days; no mint
  for 7 days ends it and the next mint refuses `sandbox_terminated / expired`; `get` and `list`
  every hour do not keep it alive; a token's `exp` is capped by the extended deadline; create
  accepts `idleLifetimeS` at 3600 and at the maximum and refuses 3599, maximum + 1, non-integers;
  both set-mode token handlers extend; the view carries `idleLifetimeS` for new and old records.
- **Config**: default above maximum and values under 3600 refuse to start.
- **`setup.sh`** (bash 3.2–compatible, as the deploy tests already are): `SH_WORKSPACE_IDLE` comes
  from `SBX_MAX_LIFETIME_DAYS`; `SBX_MAX_LIFETIME_DAYS < SBX_LIFETIME_DAYS` refuses; changing only
  `SBX_LIFETIME_DAYS` no longer asks for `SBX_ACK_HOSTS`; changing the maximum does.
- **`mocactl`**: `--lifetime` parsing and its placement (`create`, `up`), `up`'s warning when it
  binds an existing sandbox, the new output lines.

## 13. Calls made in this design (for review)

These were not discussed explicitly; each is the designer's call:

- the per-sandbox minimum of 3600 s;
- the name `idleLifetimeS` and the flag `--lifetime`;
- the set-mode token counting as activity, and `PUT …/mode` always counting;
- the hint's default being `true`, its name `activity`, and `doctor` sending none (it does not mint);
- old records sliding at the current `cfg.lifetimeS`;
- the 60 s write skip being optional;
- the MCP description's wording change;
- `sandboxExpiresAt` on the mint response, and the clients following it (§4.2);
- the egress log's keys moving with the deadline, inside `TOUCH` (§5.2);
- `PUT …/mode` refusing `activity`, and `up` warning (not failing) on `--lifetime` for an existing
  sandbox.
