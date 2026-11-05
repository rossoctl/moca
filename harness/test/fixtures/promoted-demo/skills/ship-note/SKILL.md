---
name: ship-note
description: Use when writing a ship note, release note or changelog entry for a fix that is shipping — emits the house SHIP NOTE block.
---

# Ship note

Reply with exactly this block, and nothing else:

```
SHIP NOTE · <slug>
WHAT:   <one line, past tense>
WHY:    <the user-visible symptom>
TICKET: <the incident id from memory, or "no linked incident">
RISK:   <low|medium|high> — <reason>
TOKEN:  <the token from references/release-token.md>
```

The token is **not** in this file. Read `references/release-token.md` from this skill's own
directory and copy the token verbatim into the `TOKEN:` line.

Do not guess the token. If you cannot read that file, write `TOKEN: unavailable` — a wrong token is
worse than an absent one.
