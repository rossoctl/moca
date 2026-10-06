# Set up the local Kind demo

This one-time setup runs MOCA and Context Service on a local Kind cluster.

The endpoints bind to `127.0.0.1`; do not expose this unauthenticated demo to other machines.

## Requirements

- Docker, Kind, `kubectl`, `curl`, and `openssl`
- Claude Code
- An Anthropic-compatible model credential
- This MOCA checkout
- [`contextctl`](https://github.com/rossoctl/context-service#install)

## Set up the demo

Start Claude from this MOCA checkout:

```sh
claude
```

Ask Claude to set up the demo:

```text
Set up the local Moca delegation demo. Read skills/moca-delegate-task/SKILL.md first.
```

Claude runs the setup script. If your Claude launcher loads a credential from 1Password, the setup
inherits that credential. You do not need to set any `MOCA_*` variables.

The setup creates `moca-delegate-demo`. It selects the Kubernetes context
`kind-moca-delegate-demo` before it changes cluster resources.

Ask Claude to include `--build` when you want to test local Moca and Context Service changes. The
script finds the Context Service checkout in the standard repository layout. You can also set
`CONTEXT_SERVICE_REPO` to its location.

### Run the setup script directly

If you do not use Claude, pass an existing credential to the setup script:

```sh
ANTHROPIC_API_KEY=<your-key> ./skills/moca-delegate-task/scripts/setup-kind-demo.sh
```

The script also accepts `ANTHROPIC_AUTH_TOKEN` for compatible proxy services.

After setup, continue with the [fan-out demo](./demo.md).

## Clean up

Ask Claude to remove the demo cluster:

```text
Clean up the local Moca delegation demo.
```

For direct use, run `./skills/moca-delegate-task/scripts/setup-kind-demo.sh --delete`.

Cleanup deletes only `moca-delegate-demo`. It restores the Kubernetes context that was active
before setup when that context still exists.
