# mocactl

> **Preview.** `mocactl` is implemented but not yet declared Stable. The command reference is in
> [`docs/harness/reference/cli-mocactl.md`](../../docs/harness/reference/cli-mocactl.md); the change policy in
> [`docs/reference/change-policy.md`](../../docs/reference/change-policy.md).

A terminal client for the harness: log in, manage sessions and inference credentials, and watch
turns stream live. It talks only to the control plane's `/v1` API and the harness's `/v1/turn`,
so it works the same whatever runs behind those URLs. Design:
[`docs/specs/2026-09-25-mocactl-control-plane-client-design.md`](../../docs/specs/2026-09-25-mocactl-control-plane-client-design.md).

## Documentation

- [Use mocactl](../../docs/harness/how-to/use-mocactl.md): install, keys, headless commands,
  delegation, approving a subagent's gate, sandboxes, files and troubleshooting. Every command's
  `--json` shape is one table in its
  [Headless](../../docs/harness/how-to/use-mocactl.md#headless) section.
- [Set up mocactl against the Compose trial](../../docs/harness/how-to/set-up-mocactl.md): from
  nothing to a streamed reply.
- [`mocactl` command reference](../../docs/harness/reference/cli-mocactl.md).
