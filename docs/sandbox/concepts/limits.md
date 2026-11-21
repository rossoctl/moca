---
sidebar_position: 2
---

# Limits

> **Preview.** The sandbox service is implemented, but not yet declared Stable; interfaces and
> limits may change.

- **A sandbox ends after 7 days without use** by default. Any command extends it from that
  moment: `exec`, `run`, `push`, `pull`, `shell`, or an agent's tool call. `mocactl sbx ls`,
  `mocactl sbx get` and an idle `mocactl sbx mcp` do not. Pick another lifetime with `--lifetime`
  on `mocactl sbx create` or `up`, up to the deployment's maximum (30 days by default); it is set
  at create only. When it ends, the sandbox and its files are gone: pull before. `mocactl sbx ls`
  shows each sandbox's expiry and lifetime, and `mocactl sbx doctor` fails its sandbox check in the
  last 24 hours. For a fresh sandbox, pull, `mocactl sbx rm`, then `mocactl sbx up` (an expired one
  is removed with `mocactl sbx rm --force`, as its files can no longer be checked).
- **3 sandboxes per person** by default, and a total for the whole service. Each worktree or clone
  you run `up` in uses one.
- **Delete and de-enrollment take effect within one token lifetime plus 30 s** (15 minutes by
  default, so 15.5 minutes). A sandbox token already issued keeps working until it expires. A
  command still running at that point is cancelled.
- **The longest single command is one token lifetime minus 60 s** (14 minutes by default).
  `run`'s `--timeout` defaults to, and is capped at, that. Split longer work into
  several calls.
- **Files over 12 MiB are not pushed** (`--max-file` sets another cap, sending a larger file in
  14 MiB pieces, one sandbox command each): `push` refuses and names them. Leave one out with
  `.git/info/exclude` (yours only) or `.gitignore` (shared); a tracked file is pushed even when
  ignored, so `git rm --cached` it too, which once committed removes it for everyone. A tree over
  256 MiB is refused (`--max-push` sets another cap), whatever `--max-file` allows. A pull larger
  than 8 MiB as a patch is refused, never cut.
- **What a pull does not bring back:**
  - new files the agent creates in build output, at any depth: `node_modules/`, `.venv/`,
    `venv/`, `__pycache__/`, `.pytest_cache/`, `.mypy_cache/`, `*.pyc`, and any `build/`,
    `dist/` or `target/` directory. A `build/`, `dist/` or `target/` below the top level is pulled
    in full only if you pushed a file inside it (a source directory that happens to have such a
    name). The agent's edits to files you pushed in any of these do come back. A rename inside an
    excluded directory comes back as a bare delete, and a `push` replaces the agent's new files
    there without warning, since they never count as unpulled;
  - new files under a directory your own `.gitignore` ignores are not protected: they may not come
    back, and a `push` can replace them. The same holds for an ignored file: in a repository that
    ignores `AGENTS.md`, a hand-written one is not pushed, and one the agent writes may not come
    back. Commit it (`git add -f AGENTS.md`) to have it pushed and pulled (§4); a pulled `AGENTS.md`
    comes back with a warning if it changed outside the `sbx` block.
- **Pull --apply needs a recent git.** When your files have moved on since the push, the patch is
  merged 3-way; that uses `git apply --3way --cached`, which git accepts from version 2.32
  ([git 2.32 release notes](https://github.com/git/git/blob/master/Documentation/RelNotes/2.32.0.adoc)).
  When the patch does not apply as it is, and it touches a file you have uncommitted edits to, or
  conflicts with your local commits, it is refused and nothing is changed.
- **One shared KVM host, best effort.** Every sandbox runs on one shared machine, supported in
  business hours. If it is lost, every sandbox on it ends and its files are gone. Your laptop
  keeps the original tree, so pull often.
- **Commands that keep failing for days.** If commands keep failing while the sandbox is still
  used (the relay unreachable for days), the host may reclaim the workspace before the sandbox
  reads expired: about 25 days at the default lifetime, 2 days at 30 days.
- **Older `mocactl sbx mcp` with a long lifetime.** An older `mocactl sbx mcp` counts its lease
  keepalive as use, so a sandbox it drives never ends from disuse. At a 30-day `--lifetime`
  that leaves only about 2 days of the margin above. Upgrade `mocactl` everywhere before using
  `--lifetime` above the default.

**See also.** [Admission and the microVM pool](../../project/explainers/index.md): a step-through diagram of how the pool admits, queues and reclaims work.
