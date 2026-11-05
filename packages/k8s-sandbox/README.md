# @moca/k8s-sandbox

Routes Pi tool execution (read/write/edit/bash/ls/grep/find) into a remote sandbox
over the gRPC relay (`GrpcRelayTransport`), using Pi's native `Operations` seam.
The package name is historical — the `kubectl exec` transport it was named for was
removed with the Knative/KEDA deployment path (ADR-0041).

Part of moca. The transport's design history:
[`docs/specs/2026-06-17-m2-k8s-sandbox-client-design.md`](../../docs/specs/2026-06-17-m2-k8s-sandbox-client-design.md)
and the relay-transport spec
[`docs/specs/2026-08-26-st4-go-reference-worker-design.md`](../../docs/specs/2026-08-26-st4-go-reference-worker-design.md).

## Use

The harness's `selectPoolSandbox` leases a relay presence record and hands the
leased transport to `k8sSandboxExtension()`, which requires one — a caller with
no sandbox omits the extension and Pi's local tools stand.

## Notes

- No pi-fork change: the `Operations` seam is native. The one exception is
  `grep`, whose search hardwires a local `rg`; its tool gets an `execute`
  override (`grep-tool.ts`). See `NOTES-pi-operations.md`.
- `find` honours basename globs only (no .gitignore/ignore list) — an M2
  simplification vs Pi's local `fd`.
- `SandboxExec` is one command per RPC, so the transport's `fastTier` is
  `'per-call-exec'`; a long-lived shell on the wire would be the upgrade path.
