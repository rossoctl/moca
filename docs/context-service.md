# Optional Context Service integration

MOCA can use an external Context Service to allocate a workload-scoped sandbox pool
and workspace. This integration is optional. Without it, existing `/runs` requests and static
sandbox-pool configuration behave as before.

Set `CONTEXT_SERVICE_URL` on the Knative service to enable the workload lifecycle routes:

```text
POST   /workloads
GET    /workloads/{workloadId}
DELETE /workloads/{workloadId}
```

Context Service requests time out after 5 seconds by default. Set
`CONTEXT_SERVICE_TIMEOUT_MS` to a positive number of milliseconds to override this limit.

`POST /workloads` asks Context Service to allocate the pool. A subsequent `/runs` request can pass
the returned `workloadId`; MOCA resolves it to the pool selector before leasing and
executing in a sandbox. Deleting the workload asks Context Service to release its resources.

If `CONTEXT_SERVICE_URL` is unset, the workload lifecycle routes return
`501 context_service_not_configured`. `/runs` requests that omit `workloadId` continue to use the
existing `KAGENTI_SANDBOX_POOL_SELECTOR` configuration.

## Security boundary

These routes currently assume a trusted, single-tenant deployment. MOCA forwards a
caller-provided `workspace.claimName` to Context Service and does not authenticate the caller,
authorize PVC access, or tenant-scope workload names. Context Service also does not currently
enforce those controls. Do not expose `/workloads` to untrusted or mutually untrusted clients.

A multi-tenant deployment must add authentication and enforce both PVC authorization and
tenant-scoped workload identity before enabling these routes. Kubernetes RBAC on the service
account limits what Context Service can provision, but it does not authorize one API caller
relative to another.
