# Claude Code workflow promotion: design

**Date:** 2026-09-02 · **Status:** Implemented · **ADRs:**
[ADR-0030](../adrs/0030-claude-code-workflow-promotion.md),
[ADR-0031](../adrs/0031-promoted-memory-read-only.md) · **Builds on:** M1 (Redis session
backend), M2/M3 (sandbox client + persistent channel), P1 (fs-free harness), P2 (shared
sandbox pool)

> **Amendment, 2026-09-02 — five claims corrected by measurement during implementation.** Each was
> tested against a real `~/.claude` (61 bundled skills, 586 files) rather than reasoned about, and
> each had shipped as fact in the version above:
>
> 1. **The secret scan is now two-tier, not blocking** (§4.3, §4.6, §6 D7, §8). A single blocking
>    heuristic produced 11 hits on a normal machine, every one a false positive — 7 documentation
>    placeholders and 4 _code_ expressions (`TOKEN = crypto.randomUUID`) matching because the value
>    character class accepts dotted identifiers. Two sat inside the `brainstorming` skill itself. As
>    originally specified, promotion would have been impossible on day one.
> 2. **Skill identity is the bare frontmatter `name`, never `plugin:skill`** (§4.2). All 60 on-disk
>    skills use bare names, so the namespaced deny-list entries never matched and the
>    subagent-dependency check never fired — the drop promised in §9 would silently not have happened.
> 3. **Memory indexes use markdown links, not `[[wikilinks]]`** (§4.6). The real `MEMORY.md` holds 9
>    `[Title](file.md)` links and zero wikilinks, so that check could never fire.
> 4. **The `promote` sample output below was illustrative and is now measured.**
> 5. **Preflight now blocks only on facts and warns on heuristics** (§4.6, §6 D10). The binary check
>    reported 32 missing on a real machine (half of them not binaries) and the sibling check fired 182
>    times across 28 skills, because skill prose names files the reader will create. Both are advisory
>    now; the first real end-to-end build produced 183 blocking errors and would have failed outright.
> 6. **A recommended-workflow section was added** (§11): author in a minimal sandbox rather than
>    promoting a whole `~/.claude`. Most of the pruning machinery in this spec exists only to cope
>    with an uncurated environment.
> 7. Implementation detail worth recording because it silently untracked a module: `.gitignore`'s
>    unanchored `secrets.*` pattern means the scanner lives in `secret-scan.ts`, not `secrets.ts`.

## 1. Problem

The harness runs Pi sessions well but is hard to _author for_. Getting a useful agent workflow
onto it means hand-assembling a prompt and hoping the runtime has what the prompt assumes.
Meanwhile the same person already has a working workflow on their laptop, in Claude Code:
skills they trust, a `CLAUDE.md`, accumulated memory, and a slash command that ties it
together. Nothing carries that across.

The ask is a **promotion path**: iterate locally in Claude Code until the workflow behaves,
then move it to the managed environment with one command and have it behave the same way.

Two facts make this tractable, and one makes it delicate.

**Pi already speaks most of Claude Code's configuration vocabulary.**
`pi-fork/packages/coding-agent/src/core/resource-loader.ts` exposes `getSkills()`,
`getPrompts()`, `getAgentsFiles()`, `getSystemPrompt()`, `getAppendSystemPrompt()`, and
`getExtensions()`. `core/skills.ts` implements the **Agent Skills standard** — `SKILL.md` with
`name`/`description` frontmatter, `disable-model-invocation`, and the same directory-discovery
rules Claude Code uses. `loadProjectContextFiles` (`resource-loader.ts:62`) already looks for
`CLAUDE.md` alongside `AGENTS.md`. Pi's built-in tools (`bash`, `read`, `write`, `edit`,
`grep`, `find`, `ls`) are near-isomorphic to Claude Code's.

**The harness deliberately uses none of it.** `harness/src/run-turn.ts:463` constructs
`DefaultResourceLoader` with only `{ cwd, agentDir, settingsManager, extensionFactories }`,
where `cwd` is the harness pod's own directory. No skills, prompts, context, or memory travel
today. The gap is delivery and wiring, not capability.

**The fs-free split constrains delivery.** Per
[`2026-07-02-p1-fs-free-harness-design.md`](2026-07-02-p1-fs-free-harness-design.md) the
harness mounts no shared writable volume — only an emptyDir `/tmp` — and tool calls execute in
a _separate_ sandbox pod. A "skill" therefore splits in two: its prose must be readable by the
**harness** process (it feeds the system prompt), while anything it executes must exist in the
**sandbox**. The two halves travel differently and must not drift apart.

## 2. Goals and non-goals

**Goals.**

1. One local command promotes a working Claude Code workflow; no hand-authored manifest, ever.
2. Skills, `CLAUDE.md`, memory, prompt, and slash commands travel.
3. What cannot work remotely is dropped with a machine-readable reason, before a run is paid for.
4. Re-promotion of unchanged configuration is free.
5. A promoted leaf stays replayable — the idempotency contract at `harness/src/run-leaf.ts:67`
   is preserved.
6. Absent a promoted bundle, harness behavior is unchanged.

**Non-goals.**

- **MCP servers.** Out of scope. The harness's answer is code-mode in the sandbox
  ([ADR-0005](../adrs/0005-mcp-code-mode.md)) plus the credential/egress plane; promoting local
  MCP configuration is a separate, much larger problem.
- **Subagents.** Pi has no Task equivalent (§9).
- **Installing binaries.** Preflight detects and reports; the sandbox image provides.
- **Live attach.** Driving a harness session interactively from Claude Code is the phase-2
  shape this design keeps the door open for (§6.4), not what it builds.
- **Namespaced commands.** `commands/<ns>/<cmd>.md` (Claude Code's `/<ns>:<cmd>`) is not
  recursed into; only prompts directly in the prompts directory travel. Preflight warns
  (`namespaced_prompt_skipped`) rather than silently dropping them.

## 3. Design overview

```
 laptop                            harness pod (fs-free)        sandbox pod (shared pool)
 ──────                            ─────────────────────        ────────────────────────
 ~/.claude ─┐
 repo/.claude├─ promote    ──► CAS store ──► /tmp/sh-config/<digest>/    /workspace/.sh-config/<digest>/
 memory/ ───┘    │                              skills/  prompts/            exec/  memory/
                 │                                   │                            │
                 ├─► lockfile.json (committed)   DefaultResourceLoader      absolute path in
                 └─► preflight report            + agentsFilesOverride      per-leaf prompt
```

One digest names both halves. The envelope carries the digest; nothing else about the workflow
is transmitted per-dispatch.

## 4. Bundle

### 4.1 Format

A tar+gzip blob; the digest is `sha256` over the **canonical** tar (sorted paths, normalized
mtimes and modes). Layout:

```
lockfile.json          generated; also emitted locally for committing
skills/<name>/…        whole skill directories, verbatim
context/               CLAUDE.md chain + selected memory files + MEMORY.md
prompt/                systemPrompt / appendSystemPrompt fragments
prompts/               slash commands → Pi PromptTemplates
exec/                  skill-local scripts destined for the sandbox
```

Skill _directories_ travel, not files: skills reference siblings (`superpowers:brainstorming`
reads `visual-companion.md`) and carry subtrees (`dataviz/references/`). Only `skills/` and
`prompts/` become files in the harness pod; `context/` and `prompt/` are injected inline.

`lockfile.json` records the bundle format version, the pi and harness versions built against,
every included skill with source path and content hash, every **excluded** skill with a
machine-readable reason code, included memory files, the expected sandbox image reference, and
the detected-binary list. It is committed for diffability and is preflight's input.

### 4.2 Classifier: two buckets

A skill either **travels** or is **dropped with a reason**. There is deliberately no
"travels with rewriting" bucket (§7, A1).

- **Shipped default deny-list**, matched against the **bare** frontmatter `name` — which is the
  identity `resolveSkills` dedupes on, the lockfile records, and the bundle path uses. Measured
  against 60 on-disk skills: `docx`, `pdf`, `pptx`, `xlsx` are present and drop; `artifact-design`,
  `artifact-diagramming`, `fewer-permission-prompts`, `keybindings-help`, `statusline-setup` and
  `update-config` have no `SKILL.md` on disk at all (they are Claude Code built-ins) and are retained
  only as defensive entries. A `plugin:skill` qualified form matches nothing and must not be used.
- **Subagent dependency**: skills whose operation _is_ dispatching subagents
  (`dispatching-parallel-agents`, `subagent-driven-development`) drop until §9 lands.
- **User deny-list**, additive, for personal or sensitive content. Never an allow-list — an
  allow-list is the manifest burden returning through the side door.
- **Interaction dependence** (§4.6) — warned, not dropped, and mode-sensitive.
- **Binary detection** over skill bodies and `exec/`, producing the list preflight diffs
  against the sandbox inventory. Detection only.

The deny-list is **curated, not inferred**. Grepping for `Agent` as an incompatibility signal
is a trap: the word appears in nearly every superpowers skill's prose. Preflight _warns_ on
suspicious patterns; it never silently drops on a heuristic. A wrongly-dropped skill fails
remotely and confusingly, which is the failure class this design exists to prevent.

Tool-name drift (`Bash`→`bash`, `Glob`→`find`, `LS`→`ls`) is handled by an injected
`appendSystemPrompt` note, not by editing prose.

### 4.3 Promotion command

The work lives in a testable CLI in this repo — `pnpm promote` (`harness/package.json`),
alongside `harness/src/cli.ts` — and the Claude Code slash command is a thin wrapper over it.
Building only the slash command would leave the logic untestable and unusable from CI.

**Inputs**, in Claude Code's precedence order: user scope (`~/.claude/skills`,
`~/.claude/plugins`), project scope (repo `.claude/`), and the project's memory directory.

**Dedupe is mandatory.** A representative laptop shows 149 `SKILL.md` files but far fewer
skills: `plugins/cache/` (~39 MB) is largely a resolved duplicate of `plugins/marketplaces/`
(~23 MB). Without dedupe by resolved skill identity, the lockfile double-counts and the bundle
ships each skill twice. Of ~62 MB on disk, ~11 MB is markdown; a pruned bundle measured **8.6 MB
across 411 entries** for 55 travelling skills — single-digit MB, but nearer the top of that range
than first estimated, which is one of the arguments for §11's sandbox-first authoring.

**Entry prompts** make a bundle a _workflow_ rather than a pile of configuration. The bundle
carries named templates in `prompts/`; the envelope names one plus arguments. One bundle
therefore serves many dispatches, which is what the harness's fan-out model wants.

**The secret scan is two-tier, and the split is empirical.** Promotion reads the memory directory
and `settings.json`, which in practice contain operational notes about credentials, so every file
entering the bundle is pattern-scanned. Five **structural** rules — AWS access key ids, private-key
blocks, GitHub, OpenAI-style and Slack tokens — **refuse the upload** with path and line, because a
credential reaching a shared cluster's store is not recoverable by re-promoting. The prose-shaped
**heuristic** rules (`assigned-secret`, `bearer-token`) only **warn**, with documentation-placeholder
suppression.

That asymmetry was measured, not chosen for taste. Over a real `~/.claude` the structural rules
produced zero hits and the heuristic produced 11, all false positives: 7 placeholders and 4 code
expressions such as `TOKEN = crypto.randomUUID`, which match because the value character class
accepts dotted identifiers. Two were inside the `brainstorming` skill. A blocking heuristic would
refuse essentially every promotion, and a gate nobody can pass gets bypassed or deleted.

**Accepted residual gap:** a pasted bare credential (`password: hunter2hunter2`) warns rather than
blocks. Structural formats — the shapes real leaked credentials actually take — still block.

**Idempotence.** The digest is computed locally; if the store holds it, upload is a no-op.

```
$ pnpm promote --entry brainstorm-and-plan

  resolved   60 skills (149 SKILL.md → 60 after cache/marketplace dedupe)
  travels    54
  dropped     6   docx, pdf, pptx, xlsx        (no_harness_equivalent)
                  dispatching-parallel-agents, subagent-driven-development
                                               (needs_subagent)
  context    CLAUDE.md (2 files) + 10 memory files
  secrets    no blocking findings, 4 warning(s) — see below
  binaries   gh, kubectl, pnpm  →  present in sandbox:pool-default
  entry      brainstorm-and-plan
  bundle     sha256:94e9…86d  (8.6 MB, unchanged — upload skipped)
  lockfile   .claude/promoted.lock.json  (2 skills changed since last promote)
```

### 4.4 Harness-side materialization

`LeafEnvelope` (`harness/src/run-leaf.ts:92`) gains one optional field, `configRef?: string`.
Absent means today's behavior byte for byte — the converge, solve, and swebench paths are
untouched, and the feature is opt-in with zero blast radius.

Cold start fetches by digest, unpacks into `/tmp/sh-config/<digest>/`, and caches keyed by
digest so a warm pod's second turn skips the work. A digest-keyed cache cannot go stale, so
its death with the pod is correct rather than unfortunate. Unpack goes to a temp path and is
renamed into place: a crash mid-unpack must never leave a half-populated skill directory,
which would silently truncate a skill's instructions.

Wiring at `harness/src/run-turn.ts:463`:

```ts
new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  extensionFactories,
  additionalSkillPaths: [`${dir}/skills`],
  additionalPromptTemplatePaths: [`${dir}/prompts`],
  noContextFiles: true,
  agentsFilesOverride: () => ({ agentsFiles: bundle.context }),
  appendSystemPrompt: [toolNameMappingNote, skillsRootNote, ...bundle.promptFragments],
});
```

**`noContextFiles: true` is load-bearing.** `loadProjectContextFiles` walks ancestor
directories for `CLAUDE.md`/`AGENTS.md` (`resource-loader.ts:62`). On the harness pod that walk
reaches _this repository's own_ `CLAUDE.md` — "MOCA … pnpm workspace … DCO
sign-off required." Unsuppressed, every promoted session silently inherits the harness
project's instructions as if they were the user's. `noSkills` / `noPromptTemplates` are set for
the same reason: the harness image ships none today, and explicit suppression keeps that true.

Failures are loud. An unresolvable digest, a format-version mismatch, or a checksum mismatch
**fails the leaf immediately**, digest included in the message. There is no fallback to running
unconfigured: a silently unconfigured agent producing plausible-but-wrong work is the expensive
remote failure this design exists to prevent.

The resolver is **pure with respect to the digest**, so replaying an envelope reproduces the
run — preserving the idempotency property (`run-leaf.ts:67`) that §5 depends on.

### 4.5 Sandbox-side overlay

Content enters the sandbox the way `converge.ts` already does it: build a shell script, exec it
through the transport (`buildConvergeScript`, `convergeWorkspace`), under a **per-pod flock**
that serializes concurrent converges, into a **per-leaf** path `/workspace/leaves/<runId>`.
The pool is shared ([ADR-0021](../adrs/0021-shared-sandbox-pool.md)), so nothing may be global.

Transport is a base64 tarball piped into `tar -x` in one exec — not per-file heredocs, which
would be pathological in a 200-leaf fan-out. Scripts get `chmod +x`, since tar-over-exec does
not reliably preserve the bit.

**Two-level placement.** Bundles are immutable and content-addressed, so they cache _shared_
at `/workspace/.sh-config/<digest>/`, populated once under the same flock discipline, and are
bound into each leaf's workspace. A 200-leaf fan-out pushes the bundle once, not 200 times.
Per-leaf content stays under `/workspace/leaves/<runId>/` so `cleanupWorkspace` remains the
only teardown path for it.

The shared half is **refcounted, not permanent** (#216). Each leaf registers a file under
`/workspace/.sh-config/.refs/<digest>/` before it reads the cache, and its teardown drops that
ref and removes the cache once none remain — all under the same per-pod flock, so a leaf cannot
read `hit` and then have the directory deleted beneath its symlink. The fan-out win above is
unaffected, since those leaves hold refs concurrently; what is given up is reuse across
_separate_ dispatches, so one arriving after the pool went idle re-transfers the bundle. That is
the price of goal 6 in §2 being observably true and not merely true in-process: a cache that
outlived its leaf left a world-readable `CLAUDE.md` and `memory/` on the shared volume for a
later `configRef`-less leaf to explore, and tools run in the sandbox.

**Path translation.** A skill's `SKILL.md` is read in the harness pod, but its internal paths
are written relative to where the skill lives _locally_ — `superpowers:brainstorming` instructs
a read of `skills/brainstorming/visual-companion.md`. Issued into the sandbox, that path
resolves to nothing, and the model gets a confusing miss rather than a reasonable error. So the
bundle layout is mirrored verbatim into the sandbox, the harness appends the absolute skills-
and memory-directory paths to the prompt per leaf (they vary per leaf and cannot be baked into
the content-addressed bundle), and a bundle-level note points at that fragment: _resolve
relative paths in a skill's own instructions against that skill's subdirectory under the
"Skill files:" path given elsewhere in this prompt — not against the current working
directory._ There is no seam to set an environment variable inside the sandbox (every tool call
is an independent `bash -c`), so the literal path in the prompt is the only mechanism. Without
this, every skill referencing a sibling degrades quietly.

**Binary inventory contract**, so preflight's claim is true rather than aspirational:

1. The sandbox image **declares** its inventory at a known path, baked in at build time.
2. A **copy is checked into this repo** per image tag, so preflight works offline.
3. `--verify` **probes a live sandbox** (`command -v`) for ground truth.
4. **CI asserts** the checked-in copy matches the image it describes. Without (4) the copy
   drifts and preflight starts lying — and a lying preflight is worse than none.

**Consistency.** Both halves come from one digest; the harness fails the leaf if the overlay
for that digest cannot be established. There is no partial-configuration state.

### 4.6 Preflight and the failure taxonomy

Preflight's value is entirely in being honest about its limits.

**Caught locally, no cluster.** Deny-listed skill (dropped, reason recorded); a skill
referencing a sibling absent from the bundle, found by resolving path-like references in
`SKILL.md`; a **structural** secret-scan hit (blocks) while a heuristic hit only warns (§4.3);
entry prompt not present in `prompts/`; duplicate skill names surviving dedupe, surfaced through
Pi's existing `ResourceCollision` diagnostics rather than a parallel mechanism; dangling links in
`MEMORY.md` pointing at deny-listed files (warn) — matching both the `[Title](file.md)` markdown
form that real indexes actually use and the `[[wikilink]]` form found inside memory bodies.

**Caught locally with inventory data (advisory).** Missing binary — valuable but **warn-only**,
because measurement showed the detector cannot distinguish a command from prose: on a real
`~/.claude` it reported 32 missing binaries, roughly half of which were not binaries at all
(`angular`, `django`, `vue`, `rev-parse`, and `your_command`, a literal documentation placeholder).
At error severity it refused every real promotion. A genuinely absent tool now fails remotely with a
legible `gh: not found`, which is diagnosable and re-promotable. Formerly described here as "the
highest-value check", since a
missing `gh` is the classic silent remote failure. Also sandbox pool/image-tag existence, and
harness-version-supports-bundle-format.

**Not catchable locally; run-time only.** Stated in full, because a preflight implying
completeness is worse than one stating its edges: a binary present at a different version or
with different flags; a tool present but lacking credentials; egress the sandbox denies; and
any skill whose prose assumes host behavior with no analogue but no mechanical signature.

**Interaction-dependent skills** deserve their own name. An unattended run cannot ask a
question. `superpowers:brainstorming` is the clean example — built around asking one question
at a time and waiting; promoted unattended it degenerates into the agent inventing the answers.
`receiving-code-review` shares the shape. These are technically portable and semantically
broken.

This is **mode-sensitive**, which is why it warns rather than drops:
`pnpm promote --mode unattended|attended`. Under `unattended` it is a loud warning (opt-in drop);
under `attended` — the phase-2 live-attach shape — these skills are exactly what is wanted. One
flag, and phase 2 inherits the classifier unchanged.

A partial bridge exists and is **not** built here: the harness already has a human-gate
archetype (`request_approval`, `gate.ts`,
[ADR-0016](../adrs/0016-human-gate.md)). Mapping interaction-dependent skills onto real gates
is an interesting future direction, out of scope.

## 5. Memory model: read-only in, findings out

Memory travels **read-only**. The harness writes none, and what a promoted run learns comes
back as data in the leaf result, not as a memory write. Three reasons, in descending weight:

1. **Write-back breaks idempotency.** `run-leaf.ts:67` treats `session_id` as the idempotency
   key: a retry or resume of the same envelope maps deterministically to the same session.
   Mutable shared memory makes a leaf's behavior depend on what other leaves learned first, so
   replaying an envelope no longer reproduces the run. In a 200-leaf fan-out, memory becomes a
   race.
2. **Memory writes want review, and unattended runs cannot provide it.** Local memory is good
   _because_ it is a byproduct of a human correcting the agent in a loop. An unattended run
   writing into that store is an unreviewed write into future context.
3. **The valuable findings have a better channel.** What one would actually want back are
   operational discoveries — "this cluster cannot reach X", "the sandbox image lacks Y". Those
   belong in the leaf result, which `harness/src/leaf-result-store.ts` already carries; the
   human then decides what to keep. Same learning loop, review preserved, no new infrastructure.

**Progressive disclosure, via the sandbox.** Injecting every memory file inline works at 10
files and bloats context at 200. The elegant path is blocked instructively: locally the agent
reads memory on demand with `read`, but here `read` executes in the _sandbox_, which cannot see
the harness pod's `/tmp`. So memory files are overlaid into the sandbox at a known path over
the channel `exec/` already needs, and only `MEMORY.md` is injected inline as the index. Local
semantics reproduced, one index in context, scales past any cap.

**Seam for later.** "Where memory comes from" is a resolver interface with exactly one
implementation (bundle snapshot). Pi supplies the hook: `agentsFilesOverride` makes memory just
another context source, so a future memory _service_ is a constructor argument, not a redesign.
Building that service now would be speculative work against a loop a result field closes for
free. See [ADR-0031](../adrs/0031-promoted-memory-read-only.md).

## 6. Decisions

- **D1 — Content-addressed bundle referenced by digest in the envelope.** Not git-native, not
  OCI (§7).
- **D2 — Prune by compatibility, never by relevance.** Ship everything that can work; drop only
  what provably cannot. Omission and misfire are correctness problems with no automatic fix;
  payload size is an engineering problem with a known fix (content-addressing + dedupe). Solve
  the tractable one, eliminate the intractable ones.
- **D3 — Generated lockfile, never a hand-authored manifest.** A `package-lock.json`, not a
  `package.json`.
- **D4 — Prose is never rewritten.** Tool-name drift is handled by an injected mapping note.
- **D5 — Read-only memory; findings return in the leaf result.**
- **D6 — Materialization split follows fs-free.** Prose to the harness pod's emptyDir; anything
  executable to the sandbox. One digest covers both.
- **D7 — Secret scan is two-tier**: structural credential formats block promotion (the only
  deliberate friction), the prose-shaped heuristic warns. Measured, not assumed — see §4.3.
- **D8 — Interaction dependence is mode-sensitive**, not a hard incompatibility, which keeps
  the classifier valid for phase-2 live attach.
- **D9 — Subagent support is a separate spec** (§9).
- **D10 — Preflight blocks only on facts, and warns on heuristics.** The single blocking preflight
  error is `unknown_entry` — the entry prompt provably is or is not in the bundle — alongside the
  secret scan's structural-format throw. Everything derived from scanning prose warns:
  `missing_sibling`, `missing_binary`, `dangling_memory_link`, `interaction_dependent`,
  `possible_secret`. This was not designed in; three independent measurements forced it one check at
  a time (11 false blocks from the secret heuristic, 32 from binaries, 182 from siblings), and the
  principle is what connects them. A gate that refuses every legitimate promotion protects nothing.

## 7. Alternatives considered

- **A1 — Rewrite tool names across skill files.** Rejected: a regex deciding whether "Read" is
  a tool reference or English will mangle prose, and the damage surfaces as a skill misbehaving
  remotely. An injected mapping note costs one paragraph and mutates nothing (D4).
- **A2 — Session-derived manifest.** Record which skills a good local session actually touched
  and generate the manifest from that. Rejected once payload size was measured: it buys a
  smaller bundle by reintroducing omission, losing exactly the skills a _future_ run needs.
- **A3 — Mirror `~/.claude` wholesale, unpruned.** Rejected: no meaningful preflight, and
  skills that provably cannot work (Artifact, document-skills) would misfire remotely.
- **A4 — Git-native profile ref, converged like a workspace.** Cheapest to build —
  `convergeWorkspace` exists, and a commit SHA is a free digest with real promotion history.
  Rejected on cold start: scale-to-zero means no warm cache, so _every_ cold start pays a git
  clone against a sub-second target. It also needs a cluster-reachable remote with credentials
  and pushes `~/.claude` into git. Its audit property is **stolen cheaply** instead — commit the
  small textual lockfile, move the bundle out-of-band.
- **A5 — OCI artifact for everything.** Registry infrastructure exists; digests, cosign, and
  scanning come free; and it pays for binaries in the same currency an image already uses.
  Rejected for phase 1 on loop speed — push-and-pull per promotion is hostile to
  "tweak a skill, re-promote" — and because the harness pod would need its own pull client,
  kubelet not fetching artifacts on its behalf. **Not a rival**: D1 already assumes an image
  for binaries, so signing the bundle artifact later is additive.
- **A6 — Read-write memory synced back to the laptop.** Rejected on §5(1) (idempotency) and
  §5(2) (unreviewed writes).
- **A7 — Session-scoped memory writes.** Rejected as redundant: within-run continuity is what
  `checkpoint-extension.ts` already provides, and a second mechanism for it is drift.
- **A8 — A dedicated memory service now.** The right eventual answer to a _different_ problem
  (curated, team-shared knowledge across many runs, with ownership and staleness semantics).
  Speculative here, and it would land scope in the promotion path.

## 8. Testing and acceptance

Mirroring existing conventions: `harness/test/converge.test.ts` for script generation,
`run-turn-sandbox.test.ts` for fake transports, `pool-live-smoke.test.ts` and
`packages/k8s-sandbox/test/m3-live-smoke.test.ts` for the env-gated live tier.

**Unit, no cluster or Redis** — over fixture trees shaped like `~/.claude`:

- `promote-classify.test.ts` — `cache/` vs `marketplaces/` dedupe, deny-list application,
  broken-sibling-path detection, dangling `MEMORY.md` links, collision surfacing.
- `promote-bundle.test.ts` — **digest determinism is load-bearing** and gets property-style
  coverage, not one example: identical input yields an identical digest, and a different
  directory-walk order still does. Both "re-promotion is free" and leaf replay rest on
  canonical tar. Plus secret-scan positives and negatives.

**Wiring** — `config-resolver.test.ts` asserts an unpacked bundle yields the expected skills,
prompts, and context. One test is named for the bug it guards: **the harness `CLAUDE.md`
leak**. Construct the loader with a cwd inside this repository and assert the harness project's
instructions are absent from `agentsFiles`. It is the only failure here that produces
plausible-but-wrong behavior instead of an error, so it is the only one a reviewer would never
notice.

**Overlay** — `config-overlay.test.ts`, mirroring `converge.test.ts` with an injected fake
`ExecInPod`: assert writes land only under the per-leaf path and the digest-keyed shared cache,
never globally; assert `chmod +x`; assert flock discipline matches converge's.

**Integration with Redis**, following `integration.test.ts` — round-trip by digest, a second
identical upload is a no-op, a missing digest fails fast.

**Live smoke** — `promote-live-smoke.test.ts` behind `SH_PROMOTE_LIVE_SMOKE`. It promotes a
deliberately tiny two-skill fixture and runs a leaf whose success _requires_ a promoted skill
to fire **and** that skill to read a sibling file from its own directory. That assertion is
what proves path translation end to end — otherwise the first proof arrives in production.

**Measurement** — the README claims sub-second cold start and this feature is the most
plausible thing to erode it, so the cost belongs in the evidence trail rather than in an
assertion. The end-to-end, in-cluster comparison (baseline vs. `configRef` set, against a
scaled-to-zero Revision) could not be taken during this implementation: the deployed image
predates this branch, and taking it needs a full image build, `kind load`, and a forced new
Revision. It has since been taken (see **In-cluster result**, below).

The snippet originally recorded here forced `--replicas=0` and slept 5 s. Do not use it: it does
not produce a cold start (see the second false start below), and its selector named `harness`
rather than `moca`. What was actually run:

```bash
# Wait for Knative's OWN scale-to-zero -- do not force --replicas=0, the KPA re-scales.
wait_zero() {
  local waited=0
  while [ "$waited" -lt 240 ]; do
    [ "$(kubectl -n "$NS" get pods -l serving.knative.dev/service="$KSVC" \
           --no-headers 2>/dev/null | grep -c Running)" = "0" ] && return 0
    sleep 5; waited=$((waited + 5))
  done
  return 1
}

# Alternate the arms so autoscaler and network drift hit both. A fresh output file per sample,
# and a non-200 is a hard failure: reusing one path let a dead tunnel report stale successes.
for i in 1 2 3 4 5; do
  for ref in '' '"configRef":"<digest>",'; do
    wait_zero || { echo "not cold"; continue; }
    out=$(mktemp)
    r=$(curl -s -o "$out" -w '%{time_total} %{http_code}' --max-time 300 \
      -H "$HOSTHDR" -H 'content-type: application/json' \
      -d '{"sessionId":"cold-'"$i"'","kind":"prompt",'"$ref"'"prompt":"Say PONG and nothing else."}' \
      "$BASE/runs")
    [ "${r##* }" = "200" ] && echo "${r%% *}" || echo "FAILED http=${r##* }"
    rm -f "$out"
  done
done
```

What IS measured, locally, is the cost promote's cold path adds beyond the existing inline
path — fetching the bundle from Redis by digest, verifying it, and unpacking it to disk — not
an end-to-end cold start. N=10, fresh output directory per run, real bundle built from a live
`~/.claude` (8.60 MiB, 55 skills): `getBundle` (Redis fetch + digest verify) median 52.6 ms;
`unpackBundle` (untar to disk) median 62.1 ms — **113.7 ms added to the cold path median**
(range 110.0–132.2 ms). Not on the cold path, promote-time only: `buildBundle` 292.7 ms,
`putBundle` 230.1 ms. Caveats that keep this honest: measured on loopback Redis and macOS
APFS rather than in-cluster (in a pod, Redis is a network hop and the unpack target is an
emptyDir on node disk); excludes container start, which dominates real cold start; excludes
loader init.

**In-cluster result (2026-09-03).** Taken on kind against a Revision built from `main` with
this feature in it — the image blocker above was cleared by building the promoted-workflow demo
([`../demos/promoted-workflow-demo.md`](../demos/promoted-workflow-demo.md)). N=5 per arm,
alternating baseline/promoted, each sample preceded by a wait for Knative's own scale-to-zero, one
real model call per sample (`claude-haiku-4-5`), promoted arm carrying a 12 KB bundle:

| arm                        | median | min    | max     |
| -------------------------- | ------ | ------ | ------- |
| baseline (no `configRef`)  | 6.38 s | 6.18 s | 7.43 s  |
| promoted (`configRef` set) | 7.61 s | 6.23 s | 15.31 s |

**Median delta +1234 ms, which this measurement cannot resolve.** Within-arm spread reaches
9082 ms, so the delta sits well below the noise floor: end-to-end cold start here is
dominated by container start and one model call, both of which swamp the ~114 ms of bundle fetch,
verify and unpack measured in isolation above. The honest reading is **no cold-start regression
observable at this sample size**, not "promotion costs +1234 ms". Anyone wanting a resolvable
number should measure `getBundle`+`unpackBundle` in-pod directly rather than through a cold dispatch,
or raise N by an order of magnitude.

Two false starts are recorded because both produced confident, wrong numbers. Reusing a single curl
output path let a dead port-forward report `0.0005 s responded` for ten straight samples — curl never
wrote the file and `jq` read the previous body; the driver now uses a fresh file per sample and fails
on a non-200. And forcing `kubectl scale --replicas=0` fights the KPA, which re-scales after each
served request: the first force after a served request never reached zero inside 60 s while the next
did, so every baseline sample was skipped and every promoted sample ran — a systematically one-armed
"comparison" that still printed five tidy promoted timings.

**Done means:**

1. A bundle promoted from a real `~/.claude` runs a leaf that invokes a promoted skill and
   reads a sibling file from it.
2. With `configRef` absent, the existing suite is green unmodified.
3. A planted **structural** credential (e.g. an AWS access key id) blocks promotion, while a
   heuristic-only hit warns and lets it proceed.
4. A missing binary is reported by preflight _before_ dispatch, as a warning rather than a block.
5. Re-promoting unchanged configuration uploads nothing.
6. The harness's own `CLAUDE.md` is provably absent from a promoted session.
7. Added cold-path cost (bundle fetch, verify, unpack) measured locally — 113.7 ms median; the
   end-to-end, in-cluster cold-start comparison taken on kind — median delta +1234 ms, below this
   measurement's noise floor, i.e. no observable regression (see §8 Measurement).
8. The lockfile is committed and diffs legibly between promotions.

Continuing the red-team precedent from the fs-free spec: **a grep assertion that no bundle
content is written outside `/tmp` on the harness side**, keeping the lockdown posture
([ADR-0011](../adrs/0011-harness-lockdown.md)) intact.

## 9. Deferred: subagent support

Pi has no Task equivalent — `pi-fork/packages/coding-agent/src/core/tools/` holds `bash`,
`edit`, `find`, `grep`, `ls`, `read`, `write` and nothing that spawns a nested agent. Support
is buildable, since `createAgentSession` is exported from Pi's SDK, but it needs nested session
IDs derived from the parent, budget roll-up through `budget-voter.ts`, a defined interaction
with `checkpoint-extension.ts`, and a depth cap. That is net-new code touching the two most
delicate pieces of existing machinery and warrants **its own spec**.

The seam is clean: subagent-dependent skills drop today with a stable reason code, and when the
extension lands the code flips and they travel. Nothing else in this design changes.

## 10. Risks

- **A lying preflight.** Mitigated by the CI inventory check (§4.5); without it, trust decays
  silently.
- **Deny-list rot.** Curation is a maintenance cost; a newly-added local skill family that
  cannot work remotely will misfire until the list catches up. Accepted deliberately over
  heuristic inference.
- **Cold-start regression.** Bounded by measurement (§8) rather than assumption.
- **Blob size in Redis.** Single-digit MB with dedupe and TTL is acceptable; an object store is
  the escape hatch if bundles grow, and D1's digest indirection makes that swap local.
- **Semantic drift.** A promoted workflow can behave differently for reasons no check catches
  (§4.6, tier 3). The mitigation is honesty in the report, not a promise of fidelity.

## 11. Recommended workflow: author in a sandbox, not in your whole `~/.claude`

Added after implementation, on the project owner's direction: _transporting a whole local
environment to the remote harness is inherently challenging, so the better practice is to start
Claude in a local sandbox, add only the skills and tools that workflow needs there, and run from
there._

Everything measured while building this feature argues the same way. A real `~/.claude` yielded 149
`SKILL.md` files resolving to 60 skills, 55 of which travelled, producing an 8.6 MB bundle with 45
preflight warnings — nearly all originating in skills the workflow never uses. More tellingly, three
separate preflight checks had to be demoted from blocking to advisory (§6 D10) purely because an
uncurated environment is that noisy. The classifier, the curated deny-list, and the heuristic checks
are all machinery for _coping with_ an environment that was never curated for remote execution.
Sandbox-first authoring removes the need for most of it rather than making it smarter.

**What is unaffected**, and therefore worth building either way: the bundle format and content
digest (§4.1), the content-addressed store, harness-side materialization (§4.4), the sandbox overlay
and path translation (§4.5), the injected prompt notes, and the lockfile.

**What it demotes:** relevance pruning and the curated deny-list (§4.2) shrink toward irrelevance
when the environment contains only what the workflow needs.

**What it would restore:** blocking preflight. D10 exists because an uncurated environment produces
false positives at a rate that makes blocking untenable; a curated one should yield close to zero
findings, at which point erroring on them is both safe and more useful.

**The honest cost.** The original motivation in §1 was that people already know Claude Code, so they
should be able to iterate in the environment they already have. A deliberately minimal sandbox is
less comfortable than a real setup. That is the standard dev/prod-parity trade, and parity usually
wins — but it does change the pitch from "keep working the way you work" to "work in a sandbox that
resembles production."
