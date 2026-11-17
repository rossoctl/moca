# ADR-0049: `sbx push` has no rule of its own for `up`'s agent configuration: the repository's ignore rules decide

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-11-17
- **Deciders:** MOCA team (to confirm)
- **Issue:** [rossoctl/moca#683](https://github.com/rossoctl/moca/issues/683)
- **Spec:** [`../specs/2026-10-15-sbx0-internal-sandbox-service-design.md`](../specs/2026-10-15-sbx0-internal-sandbox-service-design.md)
  §6.2 (push and pull), §6.3 (agent configuration)

## Context

`mocactl sbx up` writes the files that point a laptop's agents at the sandbox (spec §6.3):
`.mcp.json`, `.claude/settings.json` (its allow rule and, outside Cortex mode, the deny list for
Claude Code's local tools), `opencode.json` (its server and `tools: false` list), `.bob/settings.json`
and `.bob/mcp.json`, and the `sbx` block in `CLAUDE.md` and `AGENTS.md`. Its record and the binding
live in `.sbx/`. It writes them **after** its push, so the first push carries only the developer's
tree. Every later `up` or `push` finds them on disk.

The push's file list is `git ls-files --cached --others --exclude-standard` (spec §6.2, `planPush`
in `packages/mocactl/src/sbx/push.ts`): tracked files, and untracked files that are not ignored.
`planPush` always drops `.sbx/` (`isBindingPath`) and, without `--include-secrets`, the secret-shaped
names. Nothing else in the list is special-cased, so whether the agent configuration is pushed has
always depended on the repository:

- a repository that ignores none of them pushes all seven files from the second push on;
- this repository's `.gitignore` has ignored `/.bob/`, `/.mcp.json`, `/opencode.json`,
  `/opencode.jsonc`, `/AGENTS.md` and `/.sbx/` since #677, so here only the tracked
  `.claude/settings.json` and `CLAUDE.md` are pushed.

#677 changed what this repository pushes as a side effect of an ignore-list edit, with no test
pinning either outcome. #683 asks for the behavior to be decided deliberately and written down.

## Decision

We will keep the push free of any rule for agent configuration: **each file `sbx up` writes is
pushed exactly when git would list it (tracked, or untracked and not ignored), and only `.sbx/` is
always left out.** This is #683's option A, ratifying what the code already does.

The reasons:

- **Nothing in the sandbox reads these files.** The in-sandbox side gets its steering from the MCP
  server's instructions over the protocol (`MCP_INSTRUCTIONS`, `packages/sandbox-client`), the same
  text as the `sbx` block. `.mcp.json` and `.bob/` name a `mocactl sbx mcp` that only means
  something on the laptop.
- **The deny rules and Cortex mode act on the laptop.** The deny list in `.claude/settings.json`
  and OpenCode's `tools: false` keep the laptop's agent off its local tools. Cortex mode
  (`sbx up --cortex`) moves that job to a Cortex script installed on the laptop. The sandbox's
  isolation is the microVM. Pushing these files adds no protection there, and leaving them out
  removes none. Cortex mode writes the same files, minus the deny list, so the same rule covers it.
- **The ignore rules are the developer's statement of what stays local.** A repository that
  ignores this wiring (because it names one developer's sandbox and differs per working tree, as
  #677 says) keeps it on the laptop. Overriding `.gitignore` for these files would contradict that.
- **One rule for every file.** `/workspace` holds what git would commit plus the untracked files it
  does not ignore, with `.sbx/` and secrets the only exceptions. An agent-configuration exception
  would be a third rule to explain, in the riskiest code path.
- **The laptop is safe whichever way the push goes.** A pull never writes these files back
  (`AGENT_DIRS`/`AGENT_FILES` in `push.ts`). A change to `CLAUDE.md` or `AGENTS.md` outside the
  `sbx` block is applied with a warning. So the push side carries no security weight.

### Alternatives considered

- **B: always push them**, re-including them with `-x` past the ignore files. Rejected: it pushes
  laptop-only wiring with no consumer in the sandbox, and overrides the developer's own
  `.gitignore` in the push path.
- **C: push `CLAUDE.md`/`AGENTS.md` only.** Rejected: a third rule, and the two files would reach
  the sandbox by different routes (one tracked, one re-included), which is harder to predict than
  either A or B.

## Consequences

- Positive: no change to the push. The behavior is stated in the guide (§7, "What a pull does not
  bring back"), in a comment at `planPush`, and pinned by two tests in
  `packages/mocactl/test/sbx-up.test.ts` that name this ADR. They fail if the push starts skipping
  these files, or starts re-including ignored ones.
- Negative / accepted cost: `/workspace` mirrors the tree only as far as the repository's ignore
  rules allow. The same `up` pushes different files in different repositories. A hand-written
  `AGENTS.md` in a repository that ignores it is not pushed, and one the agent writes in the
  sandbox may not come back from a pull (the guide's note on ignored files). Committing it
  (`git add -f`) makes it a tracked file, which is pushed and pulled like any other.
- Follow-up owed: none. If an in-sandbox consumer of these files appears (an agent that reads
  `AGENTS.md` inside the VM), revisit with option B or C in a new ADR.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
