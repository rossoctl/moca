# Brain and hands

> **Preview.** Describes the P6 runtime on `main` as of 2026-10-12.

The agent's **brain** is the worker process: the Pi agent loop, model calls, and the session log. Its
**hands** are the sandbox, where every command and file operation runs. They are separate processes,
usually on separate machines, joined by one narrow contract. This is what makes the sandbox disposable
and keeps model-controlled code away from the process that holds credentials and session state.

## What runs where

| In the worker (brain)                              | In the sandbox (hands)                                |
| -------------------------------------------------- | ----------------------------------------------------- |
| The Pi loop, model requests, tool selection        | `bash`, `read`, `write`, `edit`, `grep`, `ls`, `find` |
| The session log in Redis, leases, sandbox affinity | The session's working directory                       |
| The model credential for the turn                  | Nothing from the worker's environment                 |

In server mode the harness refuses to run a turn without a sandbox (`SandboxRequiredError`) unless an
operator sets `SH_LOCAL_TOOLS=1`, a single-tenant development switch that `MOCA_TENANCY=multi` refuses.
The worker also runs Pi with extensions, context files, skills and prompt templates switched off and a
private agent directory, so nothing on the worker's disk steers a turn (a promoted config bundle is
overlaid explicitly).

## The contract between them

The harness talks to a sandbox through a small transport interface (`exec`, `close`). On P6 it is
implemented over gRPC and a relay:

- The sandbox runs a `remote-worker` that **dials out** to the relay and keeps a bidirectional `Attach`
  stream open. It needs no inbound port, no kubeconfig and no model key.
- The harness sends `Exec` requests to the relay (`SandboxExec`) and the relay forwards them down the
  worker's stream. An `Exec` carries a command, optional stdin, a timeout, and a `workspace_key` (the
  session id).
- The worker streams output chunks back and finishes with an exit code and a `truncated` flag.

Because the sandbox dials out, it can live behind NAT, on another network, or on a laptop. The relay is a
single replica: a restart drops attached streams and fails in-flight execs, and recovery is a retry.
The older `kubectl exec` transport was removed with the Knative/KEDA deployment path
([ADR-0041](../adrs/0041-deprecate-knative-keda-deployment.md)).

## Limits on what the hands return

Command output is capped at 8 MiB. A `bash` command that exceeds it is aborted with exit status 137 and
the marker `[output truncated]`; other tools return the truncated output with that marker, and a `read`
that would be truncated fails instead of returning partial bytes.
A command's default timeout is 30 minutes.

## The workspace

Each session gets its own directory under the sandbox's workspace root
(`<root>/<sessionId>`), selected by the `workspace_key`. The root the harness expects
(`KAGENTI_SANDBOX_CWD`) must equal the sandbox worker's `SH_WORKSPACE_ROOT`
([Configuration](../reference/configuration.md)). The per-session directory is **not a security
boundary**: sessions on one sandbox share a Unix user and container. An idle workspace is deleted after
`SH_WORKSPACE_IDLE` (30 minutes by default; the microVM installer sets 8 hours), and the next turn is
**not told** that it happened (#338). A session moved to another sandbox gets a fresh workspace, and that
turn reports `workspace_reset`.

## What the sandbox can reach

Be clear about what is and is not enforced today:

- Only `LANG`, `LC_ALL`, `LC_CTYPE` and `TZ` cross from the harness into a sandbox command, and the
  sandbox worker removes its own settings (tokens, the relay address, `SH_*`, `MOCA_*`) from child
  environments. The model credential never reaches a sandbox.
- There is **no credentialed-egress proxy** for P6 sandboxes yet. Network reach depends on the tier
  (see [Sandboxes and tiers](sandboxes-and-tiers.md)): on Kubernetes, container sandboxes reach the
  internet but not private ranges; on the single VM and in Compose they can reach anything the host can
  route to (on the VM, except the host itself); and microVM guests have no network at all.
