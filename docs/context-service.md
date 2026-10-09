# Context Service and workloads

MOCA no longer asks Context Service to allocate sandbox pools. Context Service is moving to context
storage only (rossoctl/context-service#46), and MOCA will provision workloads itself
(rossoctl/moca#455).

Until then the workload routes answer `501 workloads_unavailable`:

```text
POST   /workloads
GET    /workloads/{workloadId}
DELETE /workloads/{workloadId}
```

A `/runs` request that names a `workloadId` gets the same `501` instead of running on the default
sandbox pool. Requests without a `workloadId` are unchanged. `CONTEXT_SERVICE_URL` and
`CONTEXT_SERVICE_TIMEOUT_MS` are no longer read.
