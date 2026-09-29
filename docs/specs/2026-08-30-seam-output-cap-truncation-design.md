# ST6 — Seam-wide output cap + explicit truncation contract: design

**Issues:** [#180](https://github.com/rossoctl/moca/issues/180),
[#181](https://github.com/rossoctl/moca/issues/181),
[#185](https://github.com/rossoctl/moca/issues/185) ·
**Epic:** #89 (closed) · **Parent spec:**
[`2026-07-08-sandbox-transport-grpc-design.md`](2026-07-08-sandbox-transport-grpc-design.md) §8 ·
**Date:** 2026-08-30 · **Status:** Proposed

## 1. Problem

Spec §8 states the total-output-per-exec cap as a **seam-level** guarantee: every
`SandboxTransport` enforces it, so Pi cannot tell which backend served a flood. The
guarantee does not hold, and the three ways it fails were filed separately during the
whole-branch review that closed the epic (#184).

**Truncation has no representation in the seam's return type.** `ExecInPod` resolves
`{ stdout, exitCode: number | null }`, and `exitCode === null` is overloaded to mean _both_
"our cap tripped" and "the process produced no status" (signalled; gRPC `end.exitCode < 0`;
stream end without an `End` frame). Callers cannot distinguish them, so every consequence
below is a consequence of one missing bit.

- **#181 — a killed `bash` is reported to the model as success.** `createPodBashOps`
  returns only `{ exitCode }` (`operations.ts:82`), and Pi's bash tool treats a null exit
  code as non-failing (`pi-fork/.../tools/bash.ts:397`: `exitCode !== 0 && exitCode !== null`).
  A verbose build or test run whose stdout crosses the cap is SIGKILLed mid-flight and
  presented as having completed normally.
- **#180 — `persistentExecInPod` is an uncapped third implementation, and it serves the
  file tools.** `extension.ts:53-59` wires it to Read/Write/Edit/Ls/Find; only `bash` and
  `grep` use the capped `KubectlTransport`. `cat` a 20 MiB file through the persistent
  channel and 20 MiB comes back; the same read through either per-call transport returns
  8 MiB plus `[output truncated]`. Pi can tell the backends apart, which is what the
  guarantee exists to prevent.
- **#185 — the cap's _enforcement_ is not equivalent, and the battery cannot see it.**
  `GrpcRelayTransport` issues `Abort`, which kills the remote process. `KubectlTransport`
  kills only the local `kubectl` client; the in-pod process stops on EPIPE, if at all. The
  shared battery reduces each mechanism to a `producerStopped()` boolean supplied by that
  transport's own factory, so both report `true` and the asymmetry is invisible **by
  construction** — in the battery that is the stated evidence for the epic's
  transport-swappability claim (§11, driver #2).

### 1.1 Two findings that shaped this design

**Every other call site already fails closed.** `readFile` and `glob` throw on
`exitCode === null` (added by #184), `grep-tool.ts:44` throws via `!== 0 && !== 1`, and
`converge.ts:59` / `swebench-setup.ts:67` throw via `!== 0`. They just do it with messages
that name the wrong cause — `rg failed in pod (exit null)`,
`diff capture failed (exit null)`. So #181's false success is the **only** incorrect
behaviour among the call sites; the rest is five misleading diagnostics. That bounds this
change: one behavioural fix, five message fixes, and one new cap.

**Capping the read path costs more than #180 states.** `pi-fork/.../tools/read.ts:277`
calls `ops.readFile(absolutePath)` for the **whole file** and only then slices by
`offset`/`limit`. A cap therefore does not merely truncate one large read — it makes the
file unreachable _even through the offset/limit paging Pi's own tool description
advertises_ ("Use offset/limit for large files… continue with offset until complete").
#180 describes the cost as "partially readable → unreadable"; it is actually "fully
readable → unreadable by any means short of `bash`". §4.1 accepts that cost with an
actionable error; §8 records the alternative.

## 2. Scope

**In:** a required `truncated: boolean` on the seam's return type; the cap extended to
`persistentExecInPod`; `createPodBashOps` failing honestly; precise diagnostics at the five
call sites that already fail; declared-capability conformance covering all three
implementations; spec §8 and ADR-0024 amendments.

**Out:** any `sandbox/v1`, generated-client, or Go worker change — truncation is computed
from each transport's own local byte accounting, so this is entirely TypeScript-side (§3.3).
The #182 default-deadline divergence (separate decision, separate issue). Making the
kubectl paths genuinely stop the remote producer (§8, rejected). Any change to the 8 MiB
value itself, which stays pinned to the Go worker's `BufferCap` by
`test/output-cap-coupling.test.ts`.

## 3. Design

### 3.1 The seam

```ts
export interface ExecResult {
  stdout: Buffer;
  exitCode: number | null;
  /**
   * The seam's output cap tripped (spec §8). `stdout` is incomplete and ends with
   * OUTPUT_TRUNCATED_MARKER, the producer was stopped, and `exitCode` is null.
   */
  truncated: boolean;
}

export type ExecInPod = (
  command: string,
  opts?: {
    stdin?: Buffer;
    onData?: (chunk: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
  },
) => Promise<ExecResult>;
```

`truncated` is **required, not optional.** An optional field lets a fourth transport omit
it and read as "not truncated" — silently reintroducing exactly the divergence #180 and
#185 are about. Required, it is a compile error. The cost is updating the test fakes that
construct results by hand; that is the intended forcing function.

**Invariant: `truncated === true` ⇒ `exitCode === null`.** Asserted by the conformance
battery for every implementation.

Retaining `exitCode: null` on truncation is what makes this **backward compatible**: every
existing call site that checks `!== 0` keeps failing closed, so there is no flag day and no
call site _must_ change. The flag adds precision on top. And the previously-ambiguous
combination stays meaningful in its remaining sense — `truncated: false` with
`exitCode: null` now means, unambiguously, "no exit status, and _not_ because of our cap".

### 3.2 `KubectlTransport`, `GrpcRelayTransport`

Both already track a local `truncated` boolean; it simply is not returned. Thread it
through their resolve sites — two in `exec.ts` (cap trip, normal close), three in
`grpc-relay-transport.ts` (cap trip, `End` frame, stream end). No logic change.

### 3.3 `persistentExecInPod`: cap in the pod, not in the client

This is the substantive work. The naive approach — count bytes client-side — is wrong here
for reasons specific to this transport:

- The channel is **multiplexed**. `FrameParser` emits a frame only once both nonce markers
  have arrived, so "stop reading at the cap" would leave unparsed payload that corrupts the
  _next_ command's frames. The parser must reach the frame boundary regardless.
- The payload is **base64**. Counting wire bytes caps content at cap × 3/4 ≈ 6 MiB, so the
  trip point would differ from the other two transports — a weaker version of the very
  distinguishability #180 objects to.

Instead, extend `wrapCommand`'s pipeline so the pod caps its own output:

```diff
- { command; } | base64
+ { command; } | head -c <cap+1> | base64
```

This is better on four counts:

1. **Exact byte parity.** The cap applies to raw bytes _before_ base64 inflation, so the
   trip boundary is the same `> cap` as the other transports.
2. **`PIPESTATUS[0]` still indexes the command**, so the existing exit-code contract is
   untouched. A trip makes it 141 (SIGPIPE); we report `null` per the invariant and never
   read it, so truncation detection does not depend on 141 being distinguishable from a
   command's own internal SIGPIPE.
3. **It bounds a pre-existing O(n²).** `FrameParser.push` does `this.buf.toString("latin1")`
   on _every_ chunk, so a 20 MiB read allocates ~5.8 GB transiently. Capping the pod's
   output bounds that buffer. A side benefit, not a goal — but it is why this transport
   should have been capped on performance grounds alone.
4. No cap-time channel teardown, so no respawn cost and no interaction with the retry path.

The limit is injectable: `persistentExecInPod` takes
`deps.outputCapBytes ?? DEFAULT_OUTPUT_CAP`, mirroring `KubectlTransport`'s existing option,
and interpolates `cap + 1` into the pipeline. Without this the conformance battery could not
exercise the cap at all — it injects `outputCapBytes: 6` (`conformance.ts:83`).

Client-side, `persistentExecInPod` computes `truncated = frame.stdout.length > cap`, trims
to `cap`, appends `OUTPUT_TRUNCATED_MARKER`, and **resolves**. It must resolve, _not_ route
through the existing `fail` handler: `fail` retries via `deps.fallback`, which
`extension.ts:52` sets to the now-capped `KubectlTransport`, so a cap trip would re-run the
command and flood twice before failing anyway.

`head -c` is available: the sandbox image (`deploy/knative/sandbox.Dockerfile`) installs
GNU `coreutils` (verified: `head (GNU coreutils) 9.5`), and busybox `head` supports `-c`
regardless. The framed protocol never runs against the remote worker — `run-leaf.ts:475`
passes `transport: selected?.transport`, and `extension.ts:47-49` uses that single override
for _both_ transports, so when a gRPC record is selected `persistentExecInPod` is not
constructed at all.

### 3.4 Call sites

| Site                                     | Change                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createPodBashOps`                       | `if (r.truncated) return { exitCode: 137 }` — **#181**                                                                                                                                                                                                             |
| `readFile`                               | Split the overloaded null branch: `truncated` → size, cap, and the `bash`+`sed` range workaround; bare `null` → "signalled, no exit status"                                                                                                                        |
| `readFile` (size)                        | A truncated buffer cannot reveal the real file size, so on truncation only, `readFile` issues one `stat -c %s` to name it, omitting the size if that also fails. Error path only, so no hot-path cost — and the size is what lets the model pick a sensible range. |
| `glob`                                   | Same split                                                                                                                                                                                                                                                         |
| `grep-tool.ts:44`                        | Name truncation instead of `rg failed in pod (exit null)`                                                                                                                                                                                                          |
| `converge.ts:59`, `swebench-setup.ts:67` | Same, for `captureWorkspaceDiff` / `captureSwebenchDiff` — a >8 MiB diff currently reports `diff capture failed (exit null)`                                                                                                                                       |

**Why 137 rather than a throw.** 137 is 128+9, the conventional SIGKILL status, and the
command genuinely was killed by signal 9 at the cap — it is not a fabricated code. Pi's
existing check then throws `appendStatus(outputText, "Command exited with code 137")`, so
the model receives **both** the honest failure and the streamed output tail. A bare throw
would lose that tail: `bash.ts:382-392` applies `appendStatus` only for messages matching
`aborted` or `timeout:` and bare-rethrows everything else, so a verbose build that trips the
cap would go from "success + tail" to "error, no output". §8 records the two rejected
alternatives.

The model's visible output is otherwise unaffected by this change: our transports stream to
`onData` **uncapped** (`exec.ts:65`), and `bash.ts` builds model-visible text from those
streamed chunks, not from `result.stdout` — which `createPodBashOps` discards. #181's
observation that the cap "buys nothing on this path" is correct, and remains correct; what
changes is only that the killing is now reported.

### 3.5 Conformance battery

`runConformance` gains a declared-capability object:

```ts
type ProducerStop = 'remote-abort' | 'local-kill' | 'producer-side-cap' | 'none';

runConformance('KubectlTransport', make, { producerStop: 'local-kill', streams: true });
runConformance('GrpcRelayTransport', make, { producerStop: 'remote-abort', streams: true });
runConformance('persistentExecInPod', make, { producerStop: 'producer-side-cap', streams: false });
```

- `producerStopped(): boolean` becomes `producerStop(): ProducerStop`. Each factory reports
  the mechanism it _observed_, and the battery asserts it equals the declared value, instead
  of accepting `true` from everyone. `"none"` is what a transport that stops nothing reports;
  no transport may declare it, so a regression that deletes the stop becomes a failure rather
  than a silent `true` — **#185**.
- **Why an enum and not a "was it remote?" boolean.** A boolean would assert `false` for both
  kubectl paths, which _discards_ the existing coverage that `child.kill` is actually called —
  coverage #184's review found load-bearing (with it deleted, removing `child.kill` still
  passed). The enum keeps every transport pinned to a positive claim about its own mechanism.
- `"producer-side-cap"` is the persistent channel's honest mechanism: pod-side `head -c`
  bounds the producer at the source, so there is nothing for the client to kill. Its witness
  in the factory is that `wrapCommand` emitted the cap stage; that the stage actually caps is
  proved against a real bash in `framing.test.ts` (§5), not by the fake.
- `streams: false` is required because `persistentExecInPod` genuinely does not stream
  `onData` (`persistent-exec.ts:33`). Declaring it is the point: silently skipping the
  streaming case for one implementation is precisely how #185 arose.
- The battery asserts the §3.1 invariant, holding all three implementations to one
  contract — **#180**.

**Honest note on the declaration.** Pod-side `head -c` bounds output at the source, and a
producer that outruns it is stopped by SIGPIPE — the same EPIPE class #185 declines to count
as "we stopped it". `producer-side-cap` therefore claims only what it delivers: the bytes
cannot exceed the cap, _not_ that a hostile producer ignoring SIGPIPE stops burning CPU. It
is deliberately not `remote-abort`, which is reserved for a transport that tells the far side
to stop and can observe that it did.

## 4. Behaviour changes an operator needs to know

### 4.1 Files above 8 MiB become unreadable through Read/Edit

Not truncated — unreadable, including via `offset`/`limit` (§1.1). `readFile` throws with an
actionable message naming the file size, the cap, and the `bash`+`sed` range workaround.

Accepted because a >8 MiB file is already useless to the model: Pi clips Read output to
2000 lines / 50 KB (`truncate.ts`), so what is lost is a path that returned bytes the model
never saw and that only ever cost harness memory — and, per §3.3.3, quadratic parse time.
Failing loudly with a usable next step beats silently buffering 20 MiB to show 50 KB.

### 4.2 A capped `bash` now fails

Previously reported as success. A legitimate verbose build whose stdout crosses 8 MiB will
now surface `Command exited with code 137` with its output tail, rather than appearing to
have completed. This is the intent of #181 and is the change most likely to be noticed in
day-to-day use.

## 5. Testing

TDD throughout; each assertion verified to fail against unmutated code before the fix
lands.

- **Battery:** the `truncated ⇒ exitCode === null` invariant; declared-reach assertions for
  all three transports; a `persistentExecInPod` conformance factory.
- **Boundary pair:** exactly `cap` bytes (not truncated) and `cap + 1` (truncated), per
  transport. The `head -c <cap+1>` choice makes this the exact seam boundary, so it is worth
  pinning against an off-by-one.
- **`wrapCommand`:** the `head -c` pipeline in both forms — plain, and with the stdin
  heredoc — plus a test that `PIPESTATUS[0]` still refers to the command.
- **`createPodBashOps`:** truncation yields 137; a normal non-zero code is passed through
  unchanged.
- **Diagnostics:** each of the five call sites reports truncation distinctly from "no exit
  status".
- **Live:** the gated `SH_LIVE_RELAY=1` relay/worker suite and `m3-live-smoke` cover the
  real pod and real worker paths. **Add** a >8 MiB read to the M3 smoke: §4.1 is the one
  change with no hermetic proxy for "a real file, a real `head -c`, a real base64 pipeline",
  and a fake parser cannot show that the pod-side pipeline composes as intended.

## 6. Docs

- **Spec §8** — delete the "Known exception" paragraph in the Poisoned-output-defense
  bullet and both cap-related "Accepted divergences" entries (#181, #185); state the
  `truncated` contract, the invariant, and the per-transport producer-stop mechanism table. The #182
  default-deadline divergence stays. _Convention note:_ the registry says specs are never
  retro-edited, but §8 is the live seam contract and #184 amended it on the same grounds;
  flagging it rather than assuming.
- **ADR-0024** — a Revisions entry per decision, each with its rejected alternatives (§8).
- **`transport.ts`** — drop the "NOT yet a property of the whole seam" paragraph, which
  this change makes false.

## 7. Sequencing

**PR #187 must land first.** It edits `operations.ts`'s `glob`, which §3.4 also touches;
taking it first avoids a conflict in a security-sensitive function. #187 is a two-line fix
plus a test, currently CHANGES_REQUESTED for rejecting `rg`'s exit 1 ("no matches").

## 8. Alternatives considered and rejected

**#180 — cap the persistent channel at a higher, read-specific limit** (e.g. 64 MiB).
No realistic regression, still bounds memory. Rejected: a per-transport cap _value_ leaves
Pi able to distinguish backends by output volume between 8 and 64 MiB — a weaker form of
the defect — and the battery would assert a parameter instead of a contract.

**#180 — leave it uncapped and document permanently.** Rejected: spec §8, ADR-0024 and
`transport.ts` would carry the exception indefinitely, the battery would keep covering 2 of
3 implementations, and #180 closes as wontfix. The damaging consequence is already closed by
#184's `readFile` guard, but the distinguishability is not.

**#181 — throw a descriptive error instead of 137.** Rejected: loses the output tail from
the model's tool result (§3.4).

**#181 — patch `pi-fork`'s `bash.ts` to recognize a truncation marker and append output.**
Best message _and_ preserved output. Rejected: spans two repos, needs a fork-side commit and
submodule rebuild, for a wording improvement over a mechanism (137) that already carries
both facts.

**#181 — make truncation reject at the transport level.** The original option 1. Rejected:
contradicts spec §8's stated truncate-and-surface-the-marker contract and changes
`GrpcRelayTransport`'s behaviour, which has resolved-with-marker since ST3. The flag lets
each caller decide, which is why it is worth its cost.

**#185 — genuinely kill the in-pod process** by wrapping every command to record a pid and
issuing a second `kubectl exec` on cap trip. Rejected: a wrapper plus an extra exec on every
call, with new pid-file races, to defend a case only an already-hostile sandbox reaches —
which #57's Kata/VM isolation addresses far more directly.

**#185 — leave `producerStopped()` as-is.** Rejected: the battery would keep over-claiming
the property it exists to check, which is #185's actual complaint.

## 9. Acceptance

- `truncated` is required on the seam; all three implementations set it; the invariant is
  asserted for each.
- A `bash` crossing the cap reports failure to the model, with its output tail.
- A >8 MiB read fails with a message naming the size, the cap, and the workaround.
- `runConformance` runs against all three implementations with declared capabilities, and
  the declared producer-stop reach is asserted rather than assumed.
- Spec §8 no longer carries a cap-related exception or divergence; ADR-0024 records both
  decisions with rejected alternatives.
- `make typecheck`, `make test`, `make lint` green; gated live suites pass on Kind.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
