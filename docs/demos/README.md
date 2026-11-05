# Demos — guided walkthroughs

Hands-on tours you **drive by hand**, one command at a time, explaining as you go. Each one shows
something a conventional setup cannot do, and is structured in _acts_ so it survives being
performed live in front of an audience.

## What lives here

| Demo                                                       | Shows                                                                                                                                                                                                                                                     | Time    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| [`vm-two-user-acceptance.md`](./vm-two-user-acceptance.md) | **Two GitHub users on one P6 VM**, each on their own laptop: real device-flow logins, disjoint session lists, another user's session answering 404 like one that never existed, and a session token that cannot drive a turn in any other session         | ~20 min |
| [`vm-multi-user-demo.md`](./vm-multi-user-demo.md)         | **The whole stack on one VM**: two GitHub users on their own laptops, each agent researching live content with `curl` and `git` on its own user's key, sessions neither can reach, then the same host switched to a **Firecracker microVM per tool call** | ~40 min |

## Demo vs. smoke test vs. spec

These three overlap and are easy to confuse:

- **A demo (here)** is _performed_. It optimizes for a human explaining a claim out loud, so it
  narrates why each step matters and deliberately pauses on the moments that are hard to believe.
  Every command is copy-pasteable.
  _asserted_. It optimizes for an unattended pass/fail with no narration. Prefer the script
  when you want a pass/fail; prefer the demo when you want to _convince someone_.
- **A spec or ADR** ([`../specs/`](../specs/), [`../adrs/`](../adrs/)) records the _**why**_ — the
  decision and its rejected alternatives. A demo shows the _what_, and goes stale when the
  commands change; a decision record does not.

## Conventions

If you add a demo, follow the shape of the existing demos:

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
