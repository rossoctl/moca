---
sidebar_position: 6
---

# Use credentials

> **Preview.** The sandbox service is implemented, but not yet declared Stable; interfaces and
> limits may change.

The sandbox has no network of its own, but your operator may allow it to reach a few services
(GitHub, say) through a proxy on the host. **Credential injection** lets those calls carry _your_
token without the token ever entering the sandbox. You store the token once with `mocactl sbx
credentials add`; the host's proxy adds it to requests for the services you stored it for, and only
for your sandboxes. A second user's sandbox gets none of it.

Inside the sandbox, tools see only the placeholder `moca-placeholder` (in `GH_TOKEN`, for
example). It is not a secret and is useless anywhere else: sent straight to GitHub, it gets a
`401`. The real token is not in the sandbox's environment, its files or its memory.

## GitHub

Create a **fine-grained personal access token** limited to the repositories your sandboxes need,
with only the permissions you want the agent to have. Moca does not narrow it further: the token's
scope is your limit. Then store it, reading it from stdin so it stays out of your shell history:

```bash
mocactl sbx credentials presets          # the available presets
mocactl sbx credentials add github --preset github < token.txt
```

The `github` preset covers `github.com` (git over HTTPS) and `api.github.com` (`gh`). In the
sandbox, `git clone`, `git push` and `gh pr create` then work against those repositories. The
`github-mcp` preset does the same for GitHub's remote MCP server (`api.githubcopilot.com`); the
same PAT works, and `.mcp.json` needs no token. `api.githubcopilot.com` is not on the default
egress allowlist: the operator must add it, or the preset gets `403 destination_denied`.

## List and delete

```bash
mocactl sbx credentials ls         # names and destinations, never the secret (--json for scripts)
mocactl sbx credentials delete github
```

Injection stops **within about a minute** of a delete (the proxy caches a credential for up to
60 s by default; ask your operator for the exact value). A request already open finishes with the
token it started with; no new request carries it. Also revoke the token on GitHub if you think it
leaked.

## Internal services and MCP servers

Any other service works the same way, if your operator has allowlisted it and made it reachable
from the host (`MOCA_EGRESS_PERMIT_CIDRS` for its address range, `MOCA_EGRESS_UPSTREAM_CA` for a
private CA). Ask them first. Then:

```bash
mocactl sbx credentials add jira --host jira.corp.example:8443/api < token.txt
mocactl sbx credentials add docs-mcp --host mcp.corp.example/docs --kind bearer < token.txt
```

A destination is `host[:port][/prefix]`: the port defaults to 443, and a prefix limits the token
to that path (several MCP servers behind one gateway each get their own). Wildcard hosts are not
supported. Two of your credentials cannot hold the identical destination (`409 destination_conflict`); nested prefixes such as `mcp.corp.example` and `mcp.corp.example/jira` are fine, and the longest matching prefix wins.

## Things to know

- **`this sandbox service does not offer egress credentials`** means your operator has not enabled
  the feature. Nothing is wrong with your setup.
- A service the proxy has no credential of yours for is passed through untouched, so a `curl`
  there sends only what you give it.
- An upstream can send back a cookie it minted from your token, or echo the request's headers in
  a response; either would reach the sandbox. Use narrowly scoped, short-lived tokens, and store
  only services your operator trusts.
