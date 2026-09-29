# Demos — guided walkthroughs

Hands-on tours you **drive by hand**, one command at a time, explaining as you go. Each one shows
something a conventional setup cannot do, and is structured in _acts_ so it survives being
performed live in front of an audience.

## What lives here

| Demo                                                       | Shows                                                                                                                                                                                                                                                                      | Time    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| [`moca-demo.md`](./moca-demo.md)                           | An agent that **scales to a true zero**, resumes from cold with full memory, then **fans out into a worker fleet** that appears on demand and vanishes when the queue drains                                                                                               | ~10 min |
| [`remote-sandbox-demo.md`](./remote-sandbox-demo.md)       | A **sandbox outside the cluster** with zero inbound rules, executing a leaf's tool calls — one free-form prompt that names a different OS on each backend, and a secret planted by hand that the cluster reads back                                                        | ~10 min |
| [`promoted-workflow-demo.md`](./promoted-workflow-demo.md) | A Claude Code workflow authored on your laptop — one skill, a `CLAUDE.md`, one memory file — **running unchanged in the cluster**: the same prompt twice, one field apart, and only the promoted run can cite an incident id that exists nowhere but your memory directory | ~8 min  |

## Demo vs. smoke test vs. spec

These three overlap and are easy to confuse:

- **A demo (here)** is _performed_. It optimizes for a human explaining a claim out loud, so it
  narrates why each step matters and deliberately pauses on the moments that are hard to believe.
  Every command is copy-pasteable.
- **A smoke test** ([`../../deploy/knative/SMOKE.md`](../../deploy/knative/SMOKE.md)) is _asserted_.
  It optimizes for an unattended pass/fail with no narration. Most demos here have a scripted
  sibling — `remote-sandbox-demo.md` is `make demo-remote-sandbox`, and Act 2 of
  `moca-demo.md` is `leaf-async-smoke.sh`. Prefer the script when you want a pass/fail;
  prefer the demo when you want to _convince someone_.
- **A spec or ADR** ([`../specs/`](../specs/), [`../adrs/`](../adrs/)) records the _**why**_ — the
  decision and its rejected alternatives. A demo shows the _what_, and goes stale when the
  commands change; a decision record does not.

## Conventions

If you add a demo, follow the shape of the two above:

- **Open with the claim**, then a table of "what the normal thing needs / what this needs". A reader
  should know in fifteen seconds whether this demo is the one they want.
- **Acts, with lettered sub-steps** (`### 1a.`, `### 1b.`) so you can resume mid-performance and so
  a reviewer can cite a step.
- **Blockquote callouts (`>`) for the narration** — what to _say_, and which traps the step defends
  against. Keep them out of the code blocks so the commands stay copy-pasteable.
- **Show expected output** inline. A demo whose output you cannot compare against is a demo that
  has silently rotted.
- **End with "What just happened"** (recap the claims, numbered) and **"Cleanup"** (leave the
  cluster as you found it — restore any env you flipped _first_).
- **Be honest about limits.** A closing "Notes and limits" section naming what the demo does _not_
  show is worth more than an extra act, because it is what stops someone over-promising in a room.
