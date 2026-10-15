# @moca/sandbox-mcp (EXPERIMENTAL)

Prototype for SBX1 wave 0: Pi's seven tools served over MCP (streamable HTTP), so a coding agent on a
laptop works in a MOCA sandbox. It is **not the wave-0 build**, and is not for use beyond a single
trusted user:

- **Its HTTP endpoint has no authentication.** It binds `127.0.0.1` and must be reached only through
  an SSH tunnel. Anyone who can reach the port can run commands in its workspace.
- **One fixed workspace per process** (`SBX_WORKSPACE_KEY`): there is no lifecycle API.

What it measured (Claude Code and OpenCode, unmodified, every command in a fresh Firecracker VM):
experiment E14 in `rossoctl/moca-experiments`, `sbx/`. The finding most worth upstreaming is
`src/fewer-execs.ts`: Pi's file tools spend a VM on every pre-check, and merging the checks makes
each tool one VM (`edit` two). That belongs in `@moca/k8s-sandbox`'s operations, where the harness
benefits too.

- `/mcp`: `read`, `write`, `edit`, `ls`, `find`, `bash`, `grep`, built from Pi's tools over
  `@moca/k8s-sandbox`'s pod operations, through `GrpcRelayTransport` to today's relay.
- `/push` (POST a `.tar.gz`) and `/pull` (GET a `git diff --binary`) for `demo/sbx-push.sh` and
  `demo/sbx-pull.sh`.
- No auth: it binds `127.0.0.1` and is reached through an SSH tunnel.
- stdout gets one JSON line per call: `{op, ms, execs, ok}`. On the microVM tier one Exec is one VM.

## Run

| Variable                | Meaning                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `SH_RELAY_ADDR`         | The relay's SandboxExec listener, e.g. `127.0.0.1:9444`       |
| `MOCA_RELAY_EXEC_TOKEN` | The relay's exec bearer                                       |
| `SBX_SANDBOX_ID`        | The attached worker's id (`sh-sandbox-0` under compose)       |
| `SBX_WORKSPACE_KEY`     | Required by `microvm-worker`, ignored by the container worker |
| `SBX_HOST`, `SBX_PORT`  | Default `127.0.0.1:8787`                                      |

```bash
cd packages/sandbox-mcp && node --import tsx src/main.ts
```

Local loop: the repo's compose file with `demo/compose.override.yml`, which publishes the relay's
exec port on host loopback, starting only `redis sandbox-relay sandbox`.

## Use it from a project

Copy `demo/opencode.json` and `demo/AGENTS.md` into the project root. They register the server and
turn off OpenCode's local tools. Then:

```bash
ssh -N -L 8787:localhost:8787 <rig>   # on the rig only; locally the server is already on :8787
path/to/demo/sbx-push.sh              # replace the sandbox's /workspace with this tree
opencode
path/to/demo/sbx-pull.sh [--apply]    # the sandbox's changes since the push, as a patch
```
