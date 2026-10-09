# Context Service and workloads

MOCA no longer asks Context Service to allocate sandbox pools. Context Service now stores context
only (rossoctl/context-service#51), and MOCA will provision workloads itself (rossoctl/moca#476).

Until then the workload routes answer `501 workloads_unavailable`:

```text
POST   /workloads
GET    /workloads/{workloadId}
DELETE /workloads/{workloadId}
```

A `/runs` request that names a `workloadId` gets the same `501` instead of running on the default
sandbox pool. Requests without a `workloadId` are unchanged. `CONTEXT_SERVICE_URL` and
`CONTEXT_SERVICE_TIMEOUT_MS` are no longer read.

## Upgrading

Workloads created through the old routes are not released for you: `DELETE /workloads` is now a
`501`, and Context Service no longer manages sandbox pools. Delete their Sandboxes and workspace
PVCs with `kubectl`, as the Context Service migration note describes (`docs/api.md`, "Removed:
sandbox pools"). Then delete MOCA's workload records, which were stored in Redis without a TTL:

```bash
redis-cli --scan --pattern 'sh:workload:*' | xargs -r redis-cli del
```
