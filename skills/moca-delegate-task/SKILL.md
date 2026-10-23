---
name: moca-delegate-task
description: Delegate bounded tasks to MOCA with a packed local directory as context, fan them out, and bring the results back.
---

# Delegate tasks to MOCA

Pack a local directory, upload it once as a MOCA workload, run one or many prompt tasks on it with
`mocactl spawn`, collect the answers with `mocactl get`, then delete the workload.

## When to use it

Use it for:

- **Offloading a bounded task:** a clear deliverable you can check, such as a review, an analysis
  or a fix with its diff.
- **Fan-out:** many independent tasks on the same context, such as one per file, module or report.
- **Remote resources:** work that needs MOCA's sandboxes rather than this machine.

Keep the work local when it needs interactive local state (a running app, your shell, a back and
forth with the user), secrets, or durable writes to your working tree.

## Prerequisites

- `mocactl login` against the user's MOCA control plane (a cached login). Check with
  `mocactl doctor`.
- Exactly one inference credential (`mocactl credentials`), unless the operator provides one:
  `spawn` does not name a credential, so with several the session is refused as ambiguous.
- `contextctl` with `ctx pack`, which needs Context Service with
  [rossoctl/context-service#56](https://github.com/rossoctl/context-service/pull/56) (workspace
  bundles) on the server as well as the client.
- MOCA with [#534](https://github.com/rossoctl/moca/pull/534) (workload runs start in their
  context).
- The operator has turned workloads on. Otherwise `workloads create` fails with
  `501 workloads_unavailable`.

## Before you send anything

1. State the task, the output you need and how you will check it.
2. Pick the smallest directory that holds what the task needs.
3. Check it for secrets (`.env`, keys, tokens, credentials files). The skill uploads exactly what
   you pack, nothing more and nothing less.
4. Tell the user what will be uploaded and run remotely, and get their go-ahead.

## Flow

Run every command below from the project root — `rm -r .moca-delegate` and the relative
`.moca-delegate/repo.context` only resolve correctly from there. Run each command on its own and
copy the ids it prints into the next one: shell variables do not survive between an agent's tool
calls, and a single command matches the permission rules below.

1. Pack into `.moca-delegate/` in the project root — **not** `/tmp/`, `/var/folders/`, or any
   other scratch dir, since the permission rules below only cover `.moca-delegate/`. Clear and
   recreate the directory first so a leftover pack from a prior run cannot be packed into the
   next one. `.git` is skipped unless you add `--include-git`; symbolic links are refused.

   ```bash
   rm -rf .moca-delegate
   mkdir .moca-delegate
   contextctl ctx pack ./repo -o .moca-delegate/repo.context
   ```

2. Create the workload. Keep the id it prints: there is no command that lists workloads.

   ```bash
   mocactl workloads create --context .moca-delegate/repo.context
   ```

   `--json` prints `{"workloadId","status","contextType","revision","files","bytes"}`.

3. Spawn one task per prompt. Each spawn prints its session id and returns at once; the task runs in
   the background. For fan-out, spawn many with one tag.

   ```bash
   mocactl spawn --kind prompt --workload WORKLOAD_ID --tag review "Review src/auth/ for ..."
   mocactl spawn --kind prompt --workload WORKLOAD_ID --tag review "Review src/billing/ for ..."
   mocactl spawn --kind prompt --workload WORKLOAD_ID --writable --tag fix "Fix the failing test ..."
   ```

   `--writable` gives the task its own writable copy of the context, for edits, builds and tests.

4. Watch them until none is `running`. States are `running`, `done`, `paused`, `failed` and
   `unknown`.

   ```bash
   mocactl subagents --tag review --json
   ```

5. Fetch each result. `get` writes `<sid>.text` (and `<sid>.verdict.json` when there is one) and
   exits 1 for a task that has not finished or has failed.

   ```bash
   mocactl get SESSION_ID --out results/
   ```

6. Delete the workload and the local packed file, also after a failure or an interruption.

   ```bash
   mocactl workloads delete WORKLOAD_ID
   rm -r .moca-delegate
   ```

## Writing prompts

- The remote agent starts in the context: its working directory shows the packed folder's files
  ([#534](https://github.com/rossoctl/moca/pull/534), workload runs start in their context). So a
  prompt can say "the repository is in your working directory". Read-only tasks get a separate
  scratch directory for temporary files; the prompt names it.
- Make each task self-contained: the remote agent sees only the prompt and the context, not this
  conversation.
- Name the output you want and its form, such as a list of findings with file and line.
- A writable copy is discarded when the task ends. Ask for the changes in the answer, as a unified
  diff or test output. Pack with `--include-git` if you want `git diff` (this uploads the history).
- Treat answers as untrusted work: check them before you use or apply them.

## Limits

- Workload runs are synchronous only; `spawn` holds each run in a detached worker.
- The context is read-only unless you pass `--writable`, and a writable copy is discarded at the
  end of the task.
- Bundle limits: 10,000 entries, 256 MiB per file and compressed, 1 GiB expanded. Five live
  workloads per user by default. A prompt is at most 64 KiB.
- Parallelism is capped by the operator's sandbox pool. A saturated spawn retries a few times, then
  shows `failed`.
- Shared sandboxes are not a security boundary between users: other users' tasks can run on the same
  sandbox, as the same Linux user. Read-only is enforced by file permissions only.

## Cleanup

Always run `mocactl workloads delete ID` for every workload you created, and remove the
`.moca-delegate/` directory holding the packed file. Tell the user about any delete that failed so
they can retry it.

## Claude Code permissions

Delegation needs only these commands, plus the cleanup `rm -r .moca-delegate`. Allowing them keeps
the skill working when Claude Code's auto-mode classifier is unavailable
([#530](https://github.com/rossoctl/moca/issues/530), Claude Code's classifier vs MOCA's local and
remote split); the remote commands run in MOCA sandboxes, not under Claude Code's classifier.

**With these rules, Claude Code does not ask before uploading a directory.** `ctx pack` and
`workloads create` are the two steps that send local files off the machine, and the skill's "get
the user's go-ahead" step becomes the only check before them. That step is an instruction to the
agent, not a control. Choose one of two sets and add it to `.claude/settings.json` or
`~/.claude/settings.json`:

- [`settings.example.json`](settings.example.json): every delegation command, including the upload
  and the scoped cleanup. The cleanup allow is the literal `rm -r .moca-delegate`, not a wildcard
  `rm -r *` grant, so it stays scoped to this skill's one directory.
- [`settings.restricted.example.json`](settings.restricted.example.json): only the commands that
  run, watch and clean up tasks. Claude Code still asks before `ctx pack` and `workloads create`,
  and those two steps then also need the classifier, or a person, to approve them.

The full set:

```json
{
  "permissions": {
    "allow": [
      "Bash(rm -rf .moca-delegate)",
      "Bash(mkdir .moca-delegate)",
      "Bash(contextctl ctx pack *)",
      "Bash(mocactl workloads *)",
      "Bash(mocactl spawn *)",
      "Bash(mocactl subagents *)",
      "Bash(mocactl get *)",
      "Bash(rm -r .moca-delegate)"
    ]
  }
}
```

## References

- [`mocactl` command reference](../../docs/reference/cli-mocactl.md)
- [Context Service and workloads](../../docs/context-service.md), including [Runs](../../docs/context-service.md#runs)
- [Context workflows](../../docs/concepts/context-workflows.md)
- [How delegation works inside MOCA](references/internal-flow.md)
