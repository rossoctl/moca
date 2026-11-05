/**
 * The declaration of record for every route the knative-server handler serves.
 *
 * The control plane dispatches FROM its table (its src/routes.ts is the router); the data
 * plane's handler is a chain of `if` blocks in server.ts, so this table is a declaration OF the
 * handler instead. That asymmetry is why test/openapi-contract.test.ts has a second half: it
 * drives the real handler and asserts every entry here routes (anything but 404), which is what
 * keeps this file from drifting from the if-chain it describes.
 *
 * `surface` is the product boundary: 'client' entries are documented in
 * docs/api/harness-openapi.yaml and pinned there by the contract test; 'internal' entries are
 * served but are not a client contract — the context-service workload lifecycle, and the
 * pre-/v1 wire paths kept as aliases (issue #37).
 */

export type RouteAuth =
  | 'none'
  /**
   * Bearer session token (control-plane minted, scope turn:write): verified when presented,
   * required under SH_REQUIRE_AUTH, and it must name the request's session (MU1 §4.3).
   */
  | 'session'
  /**
   * Control-plane API token (scope api) with no session binding — the caller's subject only (the
   * workload lifecycle).
   */
  | 'subject';

export interface RouteSpec {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  operationId: string;
  auth: RouteAuth;
  surface: 'client' | 'internal';
  summary: string;
  /** Set on a pre-rename wire path; names the canonical route it duplicates. */
  aliasOf?: string;
  /** Deprecated aliases warn once per path and are removed in a later release (issue #37). */
  deprecated?: boolean;
}

export const ROUTES: RouteSpec[] = [
  {
    method: 'GET',
    path: '/health',
    operationId: 'health',
    auth: 'none',
    surface: 'client',
    summary: 'Liveness — answers `ok` with no dependencies',
  },
  {
    method: 'POST',
    path: '/v1/turn',
    operationId: 'createTurn',
    auth: 'session',
    surface: 'client',
    summary: 'Run one agent turn — sync JSON, or an SSE frame stream',
  },
  {
    method: 'POST',
    path: '/turn',
    operationId: 'createTurn',
    auth: 'session',
    surface: 'internal',
    aliasOf: '/v1/turn',
    summary: 'Pre-/v1 wire path for POST /v1/turn',
  },
  // Detachable turns (#471). No pre-/v1 aliases: these routes were born under /v1.
  {
    method: 'GET',
    path: '/v1/turn',
    operationId: 'attachTurn',
    auth: 'session',
    surface: 'client',
    summary: "Re-attach to a session's detachable turn — SSE replay from a cursor, then live",
  },
  {
    method: 'POST',
    path: '/v1/turn/cancel',
    operationId: 'cancelTurn',
    auth: 'session',
    surface: 'client',
    summary: "Cancel a session's running detachable turn",
  },
  {
    method: 'POST',
    path: '/v1/runs',
    operationId: 'createRun',
    auth: 'session',
    surface: 'client',
    summary: 'Run a leaf/solve/prompt job synchronously',
  },
  {
    method: 'POST',
    path: '/runs',
    operationId: 'createRun',
    auth: 'session',
    surface: 'internal',
    aliasOf: '/v1/runs',
    summary: 'Pre-/v1 wire path for POST /v1/runs',
  },
  {
    method: 'POST',
    path: '/run-leaf',
    operationId: 'createRun',
    auth: 'session',
    surface: 'internal',
    aliasOf: '/v1/runs',
    deprecated: true,
    summary: 'Deprecated pre-rename wire path for POST /v1/runs',
  },
  {
    method: 'GET',
    path: '/runs/status',
    operationId: 'getRunStatus',
    auth: 'session',
    surface: 'client',
    summary: 'Poll a run by session id',
  },
  {
    method: 'GET',
    path: '/run-leaf/status',
    operationId: 'getRunStatus',
    auth: 'session',
    surface: 'internal',
    aliasOf: '/runs/status',
    deprecated: true,
    summary: 'Deprecated pre-rename wire path for GET /runs/status',
  },
  // Workload lifecycle: served, but an operator/stack surface rather than a client contract —
  // deliberately outside docs/api/harness-openapi.yaml. Off unless MOCA_CONTEXT_WORKLOADS_ENABLED=1
  // and CONTEXT_SERVICE_URL are set (501 workloads_unavailable otherwise); see
  // docs/context-service.md.
  {
    method: 'POST',
    path: '/workloads',
    operationId: 'createWorkload',
    auth: 'subject',
    surface: 'internal',
    summary: 'Create a workload and its Context; returns a one-time upload grant',
  },
  {
    method: 'GET',
    path: '/workloads',
    operationId: 'listWorkloads',
    auth: 'subject',
    surface: 'internal',
    summary: "List the caller's own live workloads, newest first (paged by ?limit and ?cursor)",
  },
  {
    method: 'POST',
    path: '/workloads/{id}/uploads',
    operationId: 'createWorkloadUpload',
    auth: 'subject',
    surface: 'internal',
    summary: 'Issue a fresh upload grant while the workload awaits upload',
  },
  {
    method: 'POST',
    path: '/workloads/{id}/activate',
    operationId: 'activateWorkload',
    auth: 'subject',
    surface: 'internal',
    summary:
      'Freeze the uploaded revision; the workload becomes ready (202 provisioning while its own sandboxes start)',
  },
  {
    method: 'GET',
    path: '/workloads/{id}',
    operationId: 'getWorkload',
    auth: 'subject',
    surface: 'internal',
    summary: 'Read a workload',
  },
  {
    method: 'DELETE',
    path: '/workloads/{id}',
    operationId: 'deleteWorkload',
    auth: 'subject',
    surface: 'internal',
    summary:
      'Delete a workload: its own sandboxes first (202 deleting while pods terminate), then its Context',
  },
];
