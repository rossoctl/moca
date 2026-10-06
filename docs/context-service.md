# Optional Context Service integration

MOCA owns workloads, Sandboxes, mounts, and routing. By default, each workload Sandbox uses a
Moca-managed PVC. MOCA can also use an external Context Service to upload and mount captured local
context. Context Service is optional.

The workload lifecycle routes are:

```text
POST   /workloads
POST   /workloads/{workloadId}/uploads
POST   /workloads/{workloadId}/activate
GET    /workloads/{workloadId}
DELETE /workloads/{workloadId}
```

Context Service requests time out after 5 seconds by default. Set
`CONTEXT_SERVICE_TIMEOUT_MS` to a positive number of milliseconds to override this limit.
Set `CONTEXT_SERVICE_TOKEN` to the control-plane bearer accepted by Context Service. When its
client-facing address differs from the internal `CONTEXT_SERVICE_URL`, set
`CONTEXT_SERVICE_PUBLIC_URL` to the externally reachable base URL.
Shared context workspaces request `ReadWriteMany` storage. On single-node clusters without
`ReadWriteMany` storage, such as Kind, set `CONTEXT_SERVICE_SHARED_ACCESS_MODE=ReadWriteOnce`.
Do not use this override on a multi-node cluster because all consumers must run on one node.

`POST /workloads` creates an owned MOCA workload record and its Sandboxes. Each Sandbox gets a
writable PVC through its `volumeClaimTemplates` field. This path does not require Context Service.
Deleting the workload deletes its Sandboxes and their PVCs.

Set `contextUpload` to `true` to transport captured local context. MOCA asks Context Service to
provision a Context PVC and returns an initial upload capability. It does not create a Sandbox yet.
Set `contextType` to the type of the bundle you will upload (`workspace`, `state`, `memory`,
`knowledge`, or `artifacts`); Context Service rejects a bundle whose type differs. It defaults to
`workspace`.
The workload remains `awaiting_upload`.

Multiple native Sandboxes use separate writable PVCs. A shared workspace across multiple Sandboxes
requires `contextUpload: true` and storage that supports `ReadWriteMany`.

The upload capability contains an absolute `uploadUrl`, `token`, and `expiresAt`. The client sends
its portable context bundle directly to that URL. MOCA does not proxy bundle bytes or reveal the
backing PVC. The workload owner may call `POST /workloads/{workloadId}/uploads` to replace an
expired capability before activation.

After upload, `POST /workloads/{workloadId}/activate` includes the uploaded revision. MOCA asks
Context Service to freeze that exact revision and resolve its trusted attachment. MOCA then creates
the Sandboxes. Each Sandbox mounts only that revision read-only at `/workspace`. This order prevents
an RWO Sandbox mount from blocking the upload. A subsequent `/runs` request can pass the
`workloadId` after its status becomes `ready`.
Deleting the workload removes its Sandboxes before asking Context Service to delete its Context.

If `CONTEXT_SERVICE_URL` is unset, `contextUpload: true`, upload renewal, and activation return
`501 context_service_not_configured`. Native workload creation, status, execution, and deletion
continue to work. `/runs` requests that omit `workloadId` continue to use the existing
`KAGENTI_SANDBOX_POOL_SELECTOR` configuration.

## Security boundary

**Authentication and workload identity.** Every `/workloads` verb authenticates with the same rules
as `/turn`: a session token is required under `SH_REQUIRE_AUTH=true`, and a present-but-bad token is
refused in either mode. A workload records the subject that created it as its `owner`. Only that
subject can read it, delete it, request an upload capability, or run on it (`POST /runs` with its
`workloadId`); an unowned
workload (created without a token) can be read or run on only without one. With `SH_REQUIRE_AUTH`
off, every caller who presents no token is the same unauthenticated principal, so do not expose
`/workloads` to mutually untrusted clients unless it is on. A mismatch is `404
workload_not_found`. Re-creating a live workload that another subject owns is `409
workload_name_taken`. Workload names are still one namespace across all subjects, so a name is
first come, first served.

**Upgrading.** A workload created before owners existed has none. Under `SH_REQUIRE_AUTH=true`, an
authenticated caller cannot read, run, or delete it. An administrator must remove the legacy record
and its resources.

**PVC access is internal.** A caller cannot provide `workspace.claimName`. Context Service returns
attachment metadata only to MOCA through an authenticated service call. MOCA stores that metadata
internally and never returns the claim name from a workload route.

**Do not expose `/workloads` to mutually untrusted clients unless `SH_REQUIRE_AUTH=true`.** With it
off, every caller without a token is the same Moca principal.

Kubernetes RBAC on the service account limits what Context Service can provision, but it does not
authorize one API caller relative to another.
