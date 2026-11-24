---
sidebar_position: 5
---

# Work with a sandbox

> **Preview.** The sandbox service is implemented, but not yet declared Stable; interfaces and
> limits may change.

- **Each call is a fresh VM.** Files under `/workspace` persist from one call to the next; nothing
  else does. No process survives a call: a server, a watcher or a background job started in one
  call is gone in the next. Chain the steps into one command instead (`make build && make test`).
- **No network of its own.** A template with egress reaches only the hosts your operator
  allowlisted, through a proxy (anything else answers `403 destination_denied`); one without
  egress reaches nothing. A package installs only from a registry on the allowlist: the default
  one carries the common registries (PyPI, npm, crates.io, the Go module proxy), but your operator
  may have changed it. The templates carry the toolchains: `mocactl sbx templates ls` lists them, with
  their tools, and `mocactl sbx policy` lists each profile's egress. A refused request's body says
  that the host is not on the sandbox's egress allowlist; retrying does not help. That body shows
  only for plain-HTTP requests and clients that print it: an HTTPS request is refused at its
  `CONNECT`, so most clients (curl, git, pip) show just `403` or `CONNECT tunnel failed`, and the
  agent learns the rule from its sandbox instructions instead. To have a host
  added, ask your operator and name the host: `mocactl sbx egress` lists the hosts your sandbox
  reached and the ones it was refused. The service's own URL, opened in a browser or with `curl`,
  says the same and how to get `mocactl`.
- **One command at a time per sandbox.** The sandbox runs one call at a time, so batch the work:
  read several files in one call, run the whole test suite in one call. The agent's tools refuse a
  call that would wait more than 30 s behind another one with `sandbox busy: … retry later`, and
  the service refuses a third call in flight on one sandbox (from another terminal, say) the same
  way. The `CLAUDE.md`/`AGENTS.md` block tells the agent all of this.
- **Your secrets are not pushed.** `up` and `push` leave out `.env*`, `*.pem`, `*.key` and `id_*`
  files, and say so (`--include-secrets` pushes them; don't). Everything else that git would
  commit, plus your untracked files that are not ignored, is pushed.
- **Push again after you change files locally:**

  ```bash
  mocactl sbx push
  ```

  `push` replaces the sandbox's tree with yours. It refuses while the sandbox has changes you have
  not pulled; pull them first, or `mocactl sbx push --force` to discard them. `up` on a sandbox with
  changes not yet pulled leaves it unpushed, with a warning, and still succeeds. What is sent is
  always the **whole work tree**, whatever directory you run `up` or `push` from; run from a
  subdirectory, both say so before pushing.

- **Run a command yourself:**

  ```bash
  mocactl sbx run -- python3 -m unittest
  mocactl sbx run -- sh -c 'cd src && ls | wc -l'
  echo 'make test 2>&1 | tail -20' | mocactl sbx run
  ```

  `run -- CMD…` quotes each argument, so it runs exactly what you typed: use stdin or
  `-- sh -c '…'` for pipes, variables and globs. It exits with the command's own code, 124 when the
  command timed out, and 125 when the sandbox itself failed. A command the sandbox refused before
  starting it, for want of capacity (busy, or the template's worker at its memory budget), is sent
  again after a short backoff, up to `MOCACTL_SBX_BUSY_RETRIES` times (default 4, at most 20, 0 for none):
  nothing ran, so it still runs at most once. Refused every time, `run` (and `put`) exits 75; interrupted while waiting, 130. Like `ssh`, it passes the remote
  side's terminal escape sequences through to your terminal.

- **Write a file into the sandbox** from stdin:

  ```bash
  mocactl sbx put data/fixture.json < fixture.json
  ```

  `put` writes only under `/workspace` (a relative path is taken from there).
