# Per-sandbox egress records through the API

- **Status:** proposed with [#752](https://github.com/rossoctl/moca/issues/752); implemented (the
  control plane, then the host agent, the verifier and `mocactl sbx egress`). Shipping events has
  been exercised by tests, not yet live with events: on the deployments run so far `moca-egress` was
  off, so the logs were empty and complete. §3-§5 describe the build.
- **Date:** 2026-11-08
- **Asked for:** per-sandbox egress records available through Moca API operations, a key
  requirement for benchmark use. A benchmark grader voids a rep for a download its rules
  forbid, so it must be able to see what a sandbox reached.
- **Builds on:** [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md) (sandboxes, the janitor),
  [template lifecycle and provenance](2026-11-03-template-lifecycle-and-provenance-design.md) §7
  (records), guest egress (#623, P4.1; `remote-worker/internal/egress`).

## 1. What exists

On each KVM host one `moca-egress` proxy serves every template worker's guests. It writes **one
audit event per connection or request** (`internal/egress/audit.go`, `Event`) as a JSON line on its
stdout, so into the host's journal:

| Field                                 | Meaning                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `time`, `via`                         | when; always `moca-egress`                                                                                                                                                      |
| `vm_id`, `sid`                        | the VM, and the session id it was registered with: **for a sandbox, its workspace key, which is the sandbox id** (`launcher_firecracker.go`: `Register(…, req.ID, req.Key, …)`) |
| `sub`                                 | the subject, when the grant names one                                                                                                                                           |
| `host`, `dial_addr`, `method`, `path` | the destination; `path` without query, fragment or userinfo                                                                                                                     |
| `status`, `bytes_up`, `bytes_down`    | the outcome and volume                                                                                                                                                          |
| `credential`                          | a credential's **name** (never its value) when one was injected                                                                                                                 |
| `decision`                            | `tunnel`, `forward`, `destination_denied`, `destination_private`, `conn_cap`, `credential_injected`, …                                                                          |
| `dropped`, `coalesced`                | loss and coalescing counts (an async sink drops rather than block the proxy)                                                                                                    |

So the facts a grader needs are already recorded, per sandbox. **What's missing:** they stay in the
host's journal, so nobody can get them through Moca, and nothing ties them to the sandbox's
provenance.

## 2. Goals and non-goals

**Goals:**

- A sandbox's **owner**, or an admin, reads its egress events through the API, during its life and
  for its retention afterwards.
- A sandbox's end record names a **digest of its egress log**, so the egress is part of what the
  provenance chain proves, and a copy can be checked offline.
- No credential Moca injects is exposed: credentials are names only, and paths are logged without
  query, fragment or userinfo. **The limit:** a secret a guest
  puts in a URL path segment is logged as sent; the proxy is unchanged.
- The proxy's hot path is untouched. Shipping is off the proxy, and losing events is counted, never
  silent.

**Non-goals:**

- Changing what the proxy allows (that's the allowlist, the host operator's).
- Packet capture or request bodies.
- Moca Pi sessions' egress in this increment (§7).

## 3. The model

- **Collection, on the host:** in its `--wanted-only` runs (the 15 s wanted-state timer), the host
  agent reads the proxy's journal (`journalctl -u moca-egress.service -o json`, after its cursor in
  `$SBX_SRV/egress.cursor`) and posts the events unchanged, in batches of up to 1000 and within a
  time budget per run (at most 10 batches, within 120 s). It never acts on the proxy, and is off unless `moca-egress.service` is
  active.
  - **Only this host's sandboxes' events leave the host:** the wanted answer lists `egressSids`, the
    workspace keys of the sandboxes on its workers' builds, and the agent sends only those, plus the
    proxy's `audit_dropped` counts. One proxy may also serve other workloads' VMs (Moca's own P6
    sessions), whose events stay on the host, counted only.
  - `POST /v1/hosts/{host}/egress` `{events, cursor, oversized?}`, behind the host token; idempotent
    by (host, cursor). An event over 8 KiB is not sent; only its `sid`, as `oversized`.
  - A failed post keeps the batch and the cursor for the next run. A batch refused as malformed
    (400) is kept on the host in `egress.rejected/` and the cursor moves past it. A cursor the
    journal no longer holds restarts the read from this boot, skipping entries already sent by a
    position mark (`egress.mark`).

  The proxy itself is unchanged. Its JSON is the wire format: an event naming any field the proxy
  does not write is not stored.

- **Store, in the control plane:**
  - **Where:** Redis (where the sandbox records live): a stream `sh:sbx:egress:<sandboxId>` (one
    canonical line per event, capped at 10,000 events and 4 MiB of lines per sandbox and 64 MiB of
    lines across all logs, the excess counted as dropped), a hash `…:meta` (drop counts, sealed), a
    key per host (`sh:sbx:egress:host:<host>`, its last cursor, for replays), and the budget's keys:
    each log's bytes (`sh:sbx:egress:bytes`), the logs by expiry (`sh:sbx:egress:expiry`) and their
    running total (`sh:sbx:egress:total`). The caps are in bytes because a line may be up to 8 KiB
    and its `host` and `path` come from the guest. A post costs its own events plus the logs whose
    expiry has passed (at most 500 per post, their bytes given back), not the number of logs
    retained. Kept as long as the sandbox record: its end plus the sandbox retention
    (`SH_SANDBOX_RETENTION_SECONDS`, 14 days).
  - **Who:** an event is stored only when its `sid` is the workspace key of a sandbox on a worker of
    a build this host holds, ended at most 600 s ago; every other event is refused and counted.
    **What this rests on:** "a build this host holds" is the host's own last inventory, which
    nothing checks against placement or against the host that attached the worker. Hosts are
    trusted (each has its own bearer), so this keeps a host's events to its own sandboxes when its
    inventory is true; it is not a guarantee against a host that claims a build it does not run,
    which can write into that build's sandboxes' logs. Placement could not settle it either: it is
    computed from the same inventories, and a sandbox's worker may have run on another host during
    its life.
- **Read:**
  - `GET /v1/sandboxes/{id}/egress?after=<next>&limit=N` (1-1000, default 100), for whoever may read
    the sandbox (its owner or an admin), gives `{events, next, summary}`;
  - `summary`, on the first page only (null after it, so paging a log through reads it once):
    `byHost` (count, decisions, bytes up and down per destination host), `total`,
    `dropped`, `droppedBy` (`proxy`, `cap`, `budget`, `invalid`), `complete`, `sealed`, `sha256`.
- **The digest:** `sha256:` and the hex sha256 of the NDJSON export: each stored event's canonical
  JSON (the provenance canonicalization) followed by one newline, in arrival order.
- **Provenance:** the sandbox's `terminated` record (deleted or expired) gains
  `egress: {events, sha256, dropped, droppedBy, complete}`. Late events are accepted for 600 s after
  the end; then the janitor's sweep, if the log changed since the end record, appends one more
  `sandbox` record with `state: 'egress'` naming the final log, and seals the log. The seal comes
  last, so a sweep that fails before it is done again by the next one (the compare with the newest
  record keeps it to one record). The newest `sandbox` record that names `egress` is the log's
  digest. Record kinds are unchanged.
- **Drops:** a proxy `audit_dropped` report (no VM) is charged to every sandbox on that host's workers
  that existed within 60 s before it: a sandbox may be marked incomplete when it lost nothing, never
  complete when it did. `complete` means `dropped == 0`. One report's count is taken up to
  1,000,000 (a larger one counts as that), so a malformed report cannot write a huge count into
  every sandbox or overflow a counter.
- **Export:** `GET /v1/sandboxes/{id}/egress?format=ndjson` returns the whole log
  (`application/x-ndjson`), streamed a store page at a time, so the control plane never holds a
  whole log for it; a store failure mid-stream cuts the body short. Its sha256 equals the end record's, so a grader checks a copy offline:
  `verify-provenance.py EXPORT --egress <sandbox id>=<file>`.

## 4. The API

| Route                                         | Who                                | Answer                                                              |
| --------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `POST /v1/hosts/{host}/egress`                | a host agent, as itself            | `{accepted, refused, capped, overBudget, invalid, dropped, cursor}` |
| `GET /v1/sandboxes/{id}/egress`               | the owner, an admin                | `{events, next, summary}`                                           |
| `GET /v1/sandboxes/{id}/egress?format=ndjson` | the owner, an admin                | the log, NDJSON                                                     |
| `GET /v1/hosts/{host}/wanted`                 | a host agent, as itself (existing) | gains `egressSids`                                                  |

Errors: 404 `sandbox_not_found` for an unknown sandbox or another subject's, as for the other sandbox
routes. CLI: `mocactl sbx egress [ID] [--json | --ndjson | --verify]`.

## 5. Effects on what exists

- **The host agent:** the egress step in `--wanted-only` runs; no new unit, timer or setting. New
  0600 files under `$SBX_SRV` (cursor, mark, pending batch, `egress.rejected/`); `rm -rf /srv/sbx`
  removes them.
- **After a control-plane rollout,** the sweep may seal older sandboxes' empty logs once
  (append-only, 0 events); expected, no guard proposed.
- **The janitor's sweep** also seals ended logs (above). A workspace's removal doesn't touch its
  egress log.
- **Rollback:** deploy the control plane first. An older one answers 404 on the egress route, and the
  agent keeps its batch and retries; an older control plane ignores the egress keys (they expire),
  and reads the new `sandbox` records as before.
- **Graders:** read `…/egress` for each rep's sandbox, or check the exported log against the end
  record. A log marked incomplete is the grader's call (§6).

## 6. Decisions

1. **Who may read a sandbox's egress:** the sandbox's owner and admins, the same as the other
   sandbox routes. No separate grader role.
2. **Retention:** the sandbox record's (`SH_SANDBOX_RETENTION_SECONDS`, 14 days by default;
   `deploy/sbx/setup.sh` sets it from `SBX_RETENTION_DAYS`).
3. **A loss budget:** if the proxy dropped events for a sandbox (`audit_dropped`), the sandbox's end
   record marks its egress log incomplete, with the drop count, and the grader decides whether that
   rep is still valid.

## 7. Later

- **Moca Pi sessions' egress:** the same events, keyed by session id (the harness registers the
  session's workspace key), served on `GET /v1/sessions/{id}/egress`.
- **Shipping by the proxy itself** instead of the host agent's tail, once the format is stable.
