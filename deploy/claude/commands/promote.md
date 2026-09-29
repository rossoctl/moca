---
description: Promote this project's Claude Code workflow into MOCA
argument-hint: <entry-prompt> [--dry-run] [--deny <skill>] [--sandbox-image <ref>]
allowed-tools: Bash(pnpm --dir:*), Bash(kubectl port-forward:*), Bash(kubectl exec:*), Bash(test:*), Bash(ls:*), Bash(lsof:*), Bash(pwd), Bash(printenv:*), Bash(echo:*), Bash(git init:*)
---

<!--
allowed-tools notes, so a later edit does not widen this back:
  * kubectl is granted per verb (port-forward, exec) rather than as `kubectl:*`, because this file is
    installed into real user scope and is therefore visible in every project -- `kubectl:*` would
    carry `kubectl delete` with it.
  * pnpm is granted as `pnpm --dir`, not `pnpm:*`. It could not be while the documented invocation
    began with env assignments (`HOME=... REDIS_URL=... pnpm --dir ...`), because a grant is matched
    from the first word. Now that `--home`/`--redis-url` carry those, the first word IS `pnpm --dir`.
  * printenv, not `echo "$SH_HARNESS_DIR"`, reports the harness checkout. Measured on Claude Code
    2.1.260: any command carrying a `$VAR` is classified unanalyzable ("Contains expansion") and
    then matches NO grant, so with `defaultMode: dontAsk` the whole command aborts before the model
    sees it, and in `auto` it is denied outright. Keep every probe below expansion-free.
  * echo is granted because the probes end in `&& echo`/`|| echo`.
  * the self-exclusion probe needs nothing new: `test -f` and `echo` are already granted.
  * jq and `git rev-parse` were granted but never invoked, and are gone. `git init` stays: guard 1
    offers it.
-->

## Context

- Project being promoted (this is what travels): !`pwd`
- Harness checkout (`$SH_HARNESS_DIR`): !`printenv SH_HARNESS_DIR || echo UNSET`
- Workflow config here: !`ls -d .claude/skills .claude/commands 2>/dev/null || echo "no .claude/skills or .claude/commands"`
- Repo boundary for the context walk: !`test -e .git && echo ".git present" || echo "NO .git — see guard 1"`
- Cluster Redis tunnel on 16379: !`lsof -nP -iTCP:16379 -sTCP:LISTEN >/dev/null 2>&1 && echo "listening" || echo "absent"`
- This command lives in the project: !`test -f .claude/commands/promote.md && echo "yes — must self-exclude" || echo "no"`

## Your task

Promote the workflow in the current directory into the harness, then explain the result.

`$ARGUMENTS` — the **first** word is the entry prompt name (a file in `.claude/commands/<name>.md`).
Pass any remaining words through to the CLI verbatim. With no arguments, list the available entry
names from `.claude/commands/` and stop; do not guess one.

### Write every path out in full

You have both paths in the Context above. Substitute them **literally** into every command you run
here — never `$PWD`, never `$SH_HARNESS_DIR`, and never an inline `VAR=value` prefix.

This is a hard constraint, not a style preference. Claude Code statically parses each Bash command
and will only match it against a grant like `Bash(pnpm --dir:*)` if it can analyse it. A `$VAR`
argument is classified unanalyzable, and an inline `VAR=value` prefix moves the first word away from
the granted one; either way the command matches no grant and the best remaining outcome is a
permission prompt. Measured on 2.1.260: under `dontAsk` — a common `defaultMode` — such a command is
refused outright, and a refused probe kills this whole command before you see the Context; under
`auto` it is denied as `Contains expansion`. Expansion-free, literal commands need no prompt in any
mode, which is the entire "one slash command" claim.

### Do it all in this turn

The `allowed-tools` above hold for **this turn only**. Check the guards and run the CLI without
pausing for confirmation: if you end the turn first, the grant is gone, and the same `pnpm` command
in the next turn is refused by the permission rules (measured — a default install has no `pnpm`
rule). A preamble like "I'll check the guards, then promote" that ends there is the failure mode, not
a plan.

If a guard genuinely blocks (no `.git`, `$SH_HARNESS_DIR` unset, 16379 occupied by something else),
say so and stop — but tell the user to **re-run `/promote`** after fixing it rather than replying
"go ahead" here, and mention that launching with
`claude --allowedTools "Bash(pnpm --dir <harness-checkout>/harness promote:*)"` makes the grant
session-level so it survives a stopped turn.

### Check the three guards first

These are not hypothetical — each one produced a confident, wrong result during development.

1. **No `.git` in this directory.** `promote` bounds its `CLAUDE.md` chain walk at a `.git` entry.
   Without one it climbs into ancestor directories and sweeps their context files — including a
   personal `~/CLAUDE.md` — into a bundle bound for a shared store. If the Context above says
   `NO .git`, say so and offer `git init` before promoting. Do not promote past this silently.

2. **`$SH_HARNESS_DIR` unset or wrong.** The CLI must run from the harness checkout: there is no
   installed binary, and the sandbox inventory is resolved relative to the harness _module_, so
   running it from here would silently degrade the binary check to `inventory_unavailable`. If the
   Context says `UNSET`, stop and tell the user to
   `export SH_HARNESS_DIR=/path/to/moca`. Otherwise confirm the CLI is really there,
   with that path written out in full:
   `test -f <harness-checkout>/harness/package.json && echo yes || echo NO`.

3. **Redis.** Upload must go to the **cluster's** Redis. If the tunnel is `absent`, start it in the
   background: `kubectl port-forward -n default svc/redis 16379:6379`. Use **16379**, never 6379 —
   this repo's own test container publishes `0.0.0.0:6379`, and promoting into it reports a
   successful upload while the harness then fails with `config bundle not found` for that exact
   digest. If 16379 is in use by something that is not this tunnel, say so rather than assuming.

### Promote

```bash
pnpm --dir <harness-checkout>/harness promote --entry <entry> \
  --project <this-project> --home <this-project> --redis-url redis://localhost:16379 <extra-args>
```

`<harness-checkout>` and `<this-project>` are the two absolute paths from the Context, written out.

**If the Context above says this command lives in the project, add
`--exclude-prompt promote`.** Otherwise it ships itself into the bundle as a prompt template, since
`--home` makes this project's `.claude/commands/` the prompts directory. Add it **only** in that
case: passing it when there is no local `promote.md` produces a `prompt_exclude_unmatched` warning,
which is the flag's own typo guard firing on a false alarm.

Three of those flags are load-bearing, so do not "simplify" them:

- **`--home <this-project>`** makes this directory its own user scope, so only this workflow travels.
  Without it, promote reads your real `~/.claude` — measured at 56 travelling skills and ~8.6 MB
  versus one skill and ~12 KB — and it is also what makes this project's `.claude/commands/` entry
  prompt visible at all, since promote reads prompts from user scope only. It is exactly what
  `HOME="$PWD"` used to do here (same bundle, byte for byte); it is a flag because the env form
  cannot be granted.
- **`--project <this-project>`** is passed explicitly even though it looks redundant: run without it
  the CLI promotes whatever directory the process started in, which through `pnpm --dir` is the
  harness checkout, not this project.
- **`--redis-url`** names the tunnel from guard 3 rather than trusting an inherited `REDIS_URL`,
  which on this machine may already point at the wrong Redis of the two.

### Then verify and explain

- If the upload succeeded, confirm the bundle reached the **cluster's** store by reading it back
  through the cluster's own client, not through the tunnel — this is the only check that
  distinguishes the two Redises:
  `kubectl exec -n default deploy/redis -- redis-cli EXISTS "config:bundle:<digest>"` → expect `1`.
- Report: how many skills travelled, how many dropped and **why** for each, whether preflight was
  clean, the digest, the bundle size, whether the upload was skipped as unchanged, and the lockfile
  path. The CLI also prints `user scope:` — check it names this project and not your home directory,
  which is the one-line proof that `--home` took effect.
- Show the dispatch envelope the CLI prints, with the real digest filled in.

Interpret the exit code rather than echoing the raw error:

- **exit 2 — preflight errors.** Name what blocked. `unknown_entry` means the entry prompt is not in
  the bundle; list what is.
- **exit 3 — a structural credential match.** Give the `path:line` and the rule that matched. Say
  plainly that this one blocks because a credential reaching a shared store cannot be un-shared by
  re-promoting, and that the fix is removing it or adding the file to a deny-list — not a retry.
- **Warnings are not errors.** A clean promotion can still carry warnings (a dropped skill, a
  binary the sandbox may not have). Summarise them; do not present them as failure.

Finally, note what promotion does **not** carry: MCP servers and subagents are out of scope, and
promoted memory travels read-only, so a remote run consumes what it was taught locally and returns
discoveries in the leaf result instead of writing back.
