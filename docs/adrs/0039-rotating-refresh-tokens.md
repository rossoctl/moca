# ADR-0039: Long-lived client authentication via rotating refresh tokens, with 15-minute stateless API tokens

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-10-08
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-10-08-b14-long-lived-client-auth-design.md`](../specs/2026-10-08-b14-long-lived-client-auth-design.md)

## Context

MU1 (ADR-0033) logs a user in with GitHub device flow and returns one Ed25519 API token valid for an
hour. There is no refresh token, so `mocactl` — and the Claude Code hook planned on top of it (epic
#378) — must run an interactive login after every hour away. Issue #395 asks for reattachment after
a night asleep without interaction, with a credential that can be revoked and whose refreshes are
audited.

The control plane keeps no client-token state today. MI1 §6.2 deliberately builds no revocation list
for turn grants, relying on short lifetimes; MU1 §5.5 notes offline runs need no refresh token. Both
concern credentials that never sit on an end-user device for weeks.

## Decision

1. Device-flow login also issues an **opaque refresh token** (`mrt_` + 256 random bits), stored only
   as its SHA-256 hash in Redis under a per-login **family**.
2. `POST /v1/auth/token` (`grant_type=refresh_token`) **rotates** it: each use returns a new API token
   and a new refresh token. A superseded token presented after a 30-second grace window **revokes the
   family** (reuse detection). The check, rotation and audit entry are one Lua script.
3. A family expires after **30 days idle** or **90 days absolute**.
4. **API tokens stay stateless** and drop from 3600 s to **900 s**. Revocation takes effect at the next
   refresh; API requests do no revocation lookup.
5. `mocactl logout` revokes the current family; `mocactl logout --all` revokes all of the caller's.
6. The hook obtains tokens only through **`mocactl auth token`** (exit 0 / 3 login required /
   4 unreachable); `auth.json` (mode 0600) stays private to `mocactl`.

## Consequences

- Positive: a laptop used within 30 days never needs an interactive login, up to 90 days.
- Positive: a copied `auth.json` is detected the first time both copies refresh, and the family dies.
- Positive: roles are recomputed at each refresh, so an `SH_ADMIN_SUBJECTS` change applies within
  15 minutes.
- Negative / accepted cost: a revoked login keeps its current API token for up to 15 minutes.
- Negative / accepted cost: a crash between server-side rotation and the local write, not retried
  within 30 seconds, looks like reuse and forces a re-login.
- Negative / accepted cost: a Redis wipe logs every client out.
- Not addressed: re-checking the GitHub identity on refresh, an operator revocation surface, and
  device listing.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
