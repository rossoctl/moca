# ADR-0005: Originate MCP calls as code the model runs in the sandbox

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-18-m10-mcp-code-mode-design.md`](../specs/2026-06-18-m10-mcp-code-mode-design.md)

## Context

MCP servers are separate kagenti components with their own identities; the harness must hold no MCP backend credentials and must fit the zero-trust spine. The open question was the invocation locus — brain, hands, or gateway. At the pinned Pi commit there is no MCP client, so MCP must be built regardless of locus, and "fits Pi as-is" favors no option.

## Decision

We will have the model author and run scripts in the sandbox that call MCP over HTTP against real backend hostnames, with the AuthBridge Envoy egress waypoint transparently injecting per-user credentials, appending per-call audit entries, and enforcing a hard per-session cap — so the harness imports no MCP SDK and registers no forwarding tools.

### Alternatives considered

- **Harness-registered `registerTool` forwarding tools** — adds a Pi integration and dumps tool defs into context; the parent §3.3 approach, now superseded.
- **Standalone terminating MCP gateway** — replaced by the transparent waypoint; kagenti's `mcp-gateway` leaves the sandbox→backend data path.
- **Live inbound user token for scoping** — impossible for offline/unattended sessions; subject comes from a pre-authorized Keycloak delegation (RFC 8693 §4.1).

## Consequences

- Supersedes: the parent research doc's MCP _gateway_ (M10) — MCP becomes code run in the sandbox, not a harness-forwarded gateway call.
- Positive: Near-zero Pi surface; large token savings (progressive disclosure + filter-in-code); credentials confined to the waypoint.
- Negative / accepted cost: Isolation relaxes to "reachable only through the mediating waypoint"; static MCP roster per sandbox image; HTTP/SSE-only.
- Follow-up owed: The unattended actor-token delegation plane (M7–M9) is a hard dependency AuthBridge has not yet wired.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
