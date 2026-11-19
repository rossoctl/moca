---
sidebar_position: 1
---

# Isolation and data handling

> **Preview.** The sandbox service is implemented, but not yet declared Stable; interfaces and
> limits may change.

Why running the agent's commands in the sandbox service is safer than on your laptop:

- no process survives a call, so nothing the agent starts keeps running;
- the VM has no network device: a template without egress reaches nothing, and one with egress
  reaches only the hosts your operator allowlisted, through a proxy on the host
  ([Credentials](../how-to/egress-credentials.md)), so nothing can be downloaded from or sent to anywhere else;
- the VM holds no secrets: no credentials, no tokens, none of your laptop's files except the ones
  you pushed.

## Data handling

Your code sits on one shared KVM host that other users' sandboxes also run on. **Push no
secrets.** `sbx up` and `push` leave out common secret files by default (`.env*`,
`*.pem`, `*.key`, `id_*`), but they cannot know about every secret: keep credentials, tokens and
customer data out of the repositories you push.
