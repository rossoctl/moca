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
([ADR-0041](../../adrs/0041-deprecate-knative-keda-deployment.md)).

## Limits on what the hands return

Command output is capped at 8 MiB. A `bash` command that exceeds it is aborted with exit status 137 and
the marker `[output truncated]`; other tools return the truncated output with that marker, and a `read`
that would be truncated fails instead of returning partial bytes.
A command's default timeout is 30 minutes.

## The workspace

Each session gets its own directory under the sandbox's workspace root
(`<root>/<sessionId>`), selected by the `workspace_key`. The root the harness expects
(`KAGENTI_SANDBOX_CWD`) must equal the sandbox worker's `SH_WORKSPACE_ROOT`
([Configuration](../../reference/configuration.md)). The per-session directory is **not a security
boundary**: sessions on one sandbox share a Unix user and container. An idle workspace is deleted after
`SH_WORKSPACE_IDLE` (30 minutes by default; the microVM installer and `deploy/k8s/setup.sh` set 8
hours). The next turn is told, from a marker file (below). On a container worker, a per-session
directory that is still empty `SH_WORKSPACE_EMPTY_IDLE` (15 minutes by default) after its last command
is removed sooner (#551), unless a process is still running in it. It holds no files, and the session's
next command re-creates it. The limit: a background process that is not in the directory when the sweep
runs (one that changes into it later), and on a worker not running on Linux, where it cannot see
process working directories, any background process, is left in a deleted directory, so its later
writes there fail. While a process of the worker's own user inside the worker's cgroup hides its
working directory (a non-dumpable one, such as an ssh-agent style daemon), no empty directory is
removed early: each waits for `SH_WORKSPACE_IDLE`, and the worker logs why. A container with its own
cgroup namespace usually puts the worker at that namespace's root, where every process in the container
counts as inside. Such a process in another cgroup cannot be a session's and is ignored. A session
moved to another sandbox gets a fresh workspace, and that turn reports `workspace_reset`.

**How a turn learns of a reset (#338).** The harness keeps a small file, `.moca-session`, holding the
session id (the workspace key), at the root of the session's workspace, and records in the session's
log in Redis that it wrote it. It writes the file once the workspace holds anything, at a turn's first
command or at its end, so a container directory that is still empty stays empty for the early removal
above. At the start of every later turn, before the agent runs, one command checks the file. If the log
says it was written and it is missing, or holds another session's id, the workspace was reset on the
same sandbox: a streamed turn's first frame is `workspace_reset` with reason `reclaimed`, the turn's
placement (and so the session's resources view) records it, and the model gets a note that files from
earlier turns are gone. The note is a message of its own (`workspace_reset`, not displayed) beside the
user's prompt, which reaches the agent exactly as sent, so a `/skill:` or prompt-template call still
works and the session's history keeps the user's own words. A queued turn has no stream, but its model
gets the note. The file is written again at the end of the turn, after the agent ran: a turn that fails
or is aborted before then leaves it missing, so the next turn reports the same reset again, and a turn
that found the file intact never removes it. A check that fails is logged and the turn runs with no
verdict; it never fails the turn. A turn whose commands carry no workspace key (a workload run that
writes only in its context) has no workspace to check. The file is left out of a templated session's
patch and, when the workspace is in a git repository (a worktree or submodule included), listed in that
repository's `info/exclude`; a git that fails there is ignored. The cost is one extra command per turn,
two on a turn that starts in an empty workspace or finds a reset.

It is a convention, not a guarantee:

- A session that deletes `.moca-session` itself is reported as reset on its next turn: that cannot be
  told from a reclaim.
- A session reopened from a compaction checkpoint does not load a record older than the checkpoint, so
  the first turn after it counts as a first turn. A reset on exactly that turn is not reported; none is
  reported falsely.
- It needs a workspace per session. A container worker that predates `workspace-subdir` runs every
  session in one shared directory, where sessions overwrite each other's marker.
- It does not prevent the reset. The workspace is still deleted after `SH_WORKSPACE_IDLE`; releasing it
  explicitly when a session ends is the next step of #338.

## What the sandbox can reach

Be clear about what is and is not enforced today:

- Only `LANG`, `LC_ALL`, `LC_CTYPE` and `TZ` cross from the harness into a sandbox command, and the
  sandbox worker removes its own settings (tokens, the relay address, `SH_*`, `MOCA_*`) from child
  environments. The model credential never reaches a sandbox.
- There is **no credentialed-egress proxy** for P6 sandboxes yet. Network reach depends on the tier
  (see [Sandboxes and tiers](sandboxes-and-tiers.md)): on Kubernetes, container sandboxes reach the
  internet but not private ranges; on the single VM and in Compose they can reach anything the host can
  route to (on the VM, except the host itself); and microVM guests have no network device, reaching
  only `moca-egress`'s allowlist through the host's proxy, without credentials.
