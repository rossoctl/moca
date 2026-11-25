# moca

**Run AI coding agents' work away from where they run: in a sandbox service for the agent on your
laptop, or on a harness that runs the agent sessions themselves.**

![status](https://img.shields.io/badge/status-preview-yellow)
![node](https://img.shields.io/badge/node-22.12%2B-green)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)

Moca has two capabilities. Use either one on its own, or both together:

- **Sandbox service.** Your coding agent (Claude Code, OpenCode, Codex or IBM Bob) keeps running on
  your laptop. Every command it runs goes to a fresh, isolated VM on a shared service, working on a
  copy of your repository. You take the agent's work back as a patch. Your laptop's source files
  are untouched until you apply it, apart from the agent configuration `mocactl sbx up` writes.
- **Harness.** Moca runs the agent itself. A supervisor hands each connection to a pool of warm
  workers, sessions are durable in Redis and resume by id, and tools run in a remote sandbox (a
  container, or a Firecracker microVM per command). An orchestrator dispatches work over HTTP.

📖 **Documentation: [rossoctl.dev/moca](https://www.rossoctl.dev/moca/)**, built from
[`docs/`](docs/index.md).

## Try it

**Harness, on your laptop, in about five minutes.** You need Docker with Compose, `curl`, and a
model key:

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/deploy/compose/install.sh \
  | ANTHROPIC_API_KEY=sk-ant-... sh

curl -s -H 'Content-Type: application/json' -d '{"prompt":"Run uname -a and tell me the kernel."}' \
  http://127.0.0.1:8080/turn
```

Next step: the [harness quickstart](docs/harness/quickstart.md).

**Sandbox service.** You need a [sandbox service deployment](docs/operate/sandbox-service/install.md),
its URL, and a GitHub account enrolled in it:

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh
mocactl sbx login --control-plane-url https://<api host>
cd <your repository> && mocactl sbx up     # then run claude or opencode as usual
mocactl sbx pull --apply                   # take the agent's work back
```

Next step: the [sandbox quickstart](docs/sandbox/quickstart.md).

## Documentation

| You are…                    | Start at                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------- |
| Evaluating moca             | [Overview](docs/index.md): the two capabilities, how they relate, and when to use each  |
| Using the sandbox service   | [Sandbox quickstart](docs/sandbox/quickstart.md)                                        |
| Building on the harness     | [Harness quickstart](docs/harness/quickstart.md)                                        |
| Deploying or operating moca | [Deploy and operate](docs/operate/index.md): which deployment delivers which capability |

## Status

Every deployment path is **Preview**: this is explorative work, and interfaces may change. See
[Maturity and lifecycle](docs/reference/maturity-and-lifecycle.md).

| Path                                                         | Delivers                        | Label                            |
| ------------------------------------------------------------ | ------------------------------- | -------------------------------- |
| [Docker Compose](docs/operate/harness/compose.md)            | Harness (trial)                 | Preview, trial only              |
| [Single VM](docs/operate/harness/single-vm.md)               | Harness                         | Preview                          |
| [Kubernetes / OpenShift](docs/operate/harness/kubernetes.md) | Harness                         | Preview, first target for Stable |
| [MicroVM tier (P4)](docs/operate/harness/microvm-tier.md)    | The harness's microVM sandboxes | Preview                          |
| [Sandbox service](docs/operate/sandbox-service/install.md)   | Sandbox service                 | Preview                          |

Roadmap and the evidence behind moca's design: [Project](docs/project/index.md) (a draft).

Releases: [GitHub releases](https://github.com/rossoctl/moca/releases). Images:
`ghcr.io/rossoctl/moca` and `ghcr.io/rossoctl/moca-remote-worker`.

## Repository layout

| Path                                                                             | What it is                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `harness/`, `packages/server`, `packages/supervisor`, `packages/session-backend` | The harness runtime: Pi agent adapter, worker and server entrypoints, the P6 supervisor, Redis sessions |
| `packages/control-plane`                                                         | Login, sessions, credentials and sandboxes (route profiles `harness`, `sandbox`, `combined`)            |
| `packages/sandbox-relay`, `packages/k8s-sandbox`, `packages/sandbox-client`      | The gRPC relay, sandbox transports, and the `sandbox/v1` client with its MCP server                     |
| `remote-worker/`                                                                 | Go: container and microVM sandbox workers, egress proxy, `vmpoolctl`                                    |
| `packages/mocactl`                                                               | `mocactl`, the client for both capabilities                                                             |
| `deploy/`                                                                        | `compose/`, `vm/`, `k8s/`, `microvm/`, `sbx/` deployments                                               |
| `docs/`                                                                          | The documentation source, published at rossoctl.dev/moca                                                |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[Contributing to the docs](docs/CONTRIBUTING-DOCS.md). DCO sign-off is required
(`git commit -s`).

## License

[Apache-2.0](LICENSE)
