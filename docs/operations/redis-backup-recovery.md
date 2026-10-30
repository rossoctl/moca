# Redis backup and recovery

> **Preview.** For P6 on Kubernetes. **The repository documents no backup or restore procedure**, so this page
> describes what is stored and what a loss costs, and recommends no backup method.

## How Redis is deployed

A single-replica StatefulSet running `valkey/valkey:9-alpine` (pinned by digest; the RESP-compatible
BSD-3 fork of Redis — the resources keep `redis` names) on a `ReadWriteOnce` volume of **1Gi**
using the cluster's default StorageClass. `setup.sh` warns if there is no default class; without one `redis-0`
stays Pending. The generated configuration is exactly `requirepass`, `appendonly yes` and `dir /data`.

- **No `appendfsync`, `save`, `maxmemory` or eviction policy is set**, so Valkey 9 defaults apply. With AOF that
  usually means about one second of writes can be lost on a hard crash (a Redis default, not a repository
  guarantee). Nothing evicts.
- The container limit is **256Mi of memory**, which the data set can outgrow before it fills the 1Gi volume; an OOM
  kill would follow. No relationship between the two is documented.
- Only the supervisor, relay and control plane can reach port 6379. The root filesystem is read-only; only `/data` is
  writable.
- The smoke test deletes `redis-0` and checks that a session survives the AOF reload.

The single-VM and Compose deployments differ: Redis has no named volume there. Whether the image's anonymous
`/data` volume survives a container recreate is not established by the repository, so assume that removing or
replacing the container (including re-running `setup-vm.sh`) loses everything. See [Sessions and turns](../concepts/sessions-and-turns.md).

## What lives in Redis

| Data                                                   | Expires                              | If Redis is lost                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session logs (`session:<sid>`, `:seq`)                 | **Never**                            | Conversation history is gone                                                                                                                                  |
| Session ownership (`sh:cp:session:<sid>`, owner index) | Never                                | Users no longer see their sessions                                                                                                                            |
| Refresh tokens (`sh:cp:refresh:*`)                     | 30 days idle, 90 days absolute       | Clients' refresh tokens are gone, so every client must log in again                                                                                           |
| Audit stream (`sh:cp:audit`, `:anon`)                  | Trimmed to about 1,000,000 / 100,000 | Audit history is gone                                                                                                                                         |
| Config bundles and budget index                        | Bundles 30 days                      | Sessions on a promoted bundle fail with 410 `config_bundle_not_found` until re-promoted                                                                       |
| Detachable-turn logs (`sh:turn:*`)                     | `SH_TURN_LOG_TTL_S` (24 h)           | Re-attach to recent turns fails                                                                                                                               |
| Leaf results (`leaf:result:<sid>`)                     | `LEAF_RESULT_TTL_SECONDS` (24 h)     | Stored results are gone                                                                                                                                       |
| Sandbox presence (`sh:sandbox:records`)                | None                                 | Rebuilt when sandboxes (re)attach to the relay; whether already-attached sandboxes rewrite it after a Redis-only wipe is unverified, so restart the sandboxes |
| Affinity, detach marks, leases                         | Affinity 24 h; leases about 60 s     | Pinning is lost; leases heal within seconds                                                                                                                   |

**Credentials are not in Redis.** Per-user credentials are Kubernetes Secrets in the `moca-credentials` namespace,
encrypted under `SH_CREDENTIAL_KEK`. Losing Redis leaves them intact; back up those Secrets too.

## Backing up

The repository documents no backup procedure, and none has been tested, so this page does not recommend one.

Because sessions never expire, plan **retention**: delete sessions you no longer need (`mocactl sessions delete ID`,
which also removes the log and stored leaf results) and watch Redis memory against 256Mi and the volume against 1Gi.

## Restoring

No ordering is required. The control plane and supervisor reconnect to Redis on their own without a restart (the
control plane retries forever with the delay capped at 2 seconds; the session clients retry a bounded number of
times and reconnect on their next call), and the control plane's `/readyz` reports 503 while Redis is down and recovers by itself. With Redis down, session
routes return 503 `redis_unavailable` while credential routes keep working.

If Redis comes back from an older copy of its data, session records may reference entries newer than that copy. The
behaviour is not verified.

## Secrets to back up separately

`setup.sh` creates the first four rows once and never rotates them; the per-user Secrets in `moca-credentials` are
created by the control plane at runtime. On OpenShift and with P4 hosts it also creates `moca-relay-sandbox-tokens`
and `moca-relay-tls`, which belong in the same backup.

| Secret                               | Contents                                                                                                  | If lost                                                                                                                                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `moca-mu1`                           | `SH_SESSION_TOKEN_PRIVATE_KEY`, `SH_SESSION_TOKEN_PUBLIC_KEYS`, `SH_CREDENTIAL_KEK`, `SH_EXCHANGE_TOKEN`  | **Losing the KEK makes every stored credential unreadable**, with no way back without the old key. Losing the signing key invalidates every outstanding access and session token; clients that refresh should recover (not verified) |
| `moca-credentials` namespace Secrets | One encrypted Secret per user                                                                             | Users must re-add their credentials                                                                                                                                                                                                  |
| `moca-redis`                         | `REDIS_PASSWORD` (kept once generated), plus `REDIS_URL` and `redis.conf` re-derived from it on every run | Re-run `setup.sh`; restart Redis and its consumers                                                                                                                                                                                   |
| `moca-relay`, `moca-relay-attach`    | Relay tokens                                                                                              | Restart the relay, supervisor and sandboxes after a change                                                                                                                                                                           |

### Rotating keys

- **Credential KEK:** `SH_CREDENTIAL_KEK` is a comma-separated ring, newest first. The newest key seals, and every key
  is tried to open, so a rotation prepends a new key, lets writes re-seal forward, and later drops the old key.
  Each entry is base64 that decodes to exactly 32 bytes (for example `openssl rand -base64 32`), and a credential sealed under a dropped key reads as an error. **`setup.sh`
  cannot do this**: it only fills missing keys, and deleting `moca-mu1` and re-running generates a _new_ KEK and
  destroys every stored credential.
- **Token signing key:** the verifier accepts a list of `<kid>:<public key>` entries, so a rotation publishes the new
  key beside the old, rolls the verifier, then switches signing. Deleting `moca-mu1` replaces the key with no overlap,
  which invalidates every outstanding access and session token. Refresh tokens are opaque values stored in Redis, and
  the refresh route takes no API token and mints new tokens with the current key, so a client that refreshes should
  recover without logging in again. That has not been verified.
