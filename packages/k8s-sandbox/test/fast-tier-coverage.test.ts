import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src');

/**
 * #245, the acceptance item the type alone cannot carry.
 *
 * `SandboxTransport.fastTier` is REQUIRED, so a fourth transport cannot OMIT the claim —
 * that much is a compile error, and it is the half `transport.ts` already pins. What the
 * type cannot pin is that the claim was ever CHECKED: a fourth transport can declare
 * `fastTier: 'persistent-channel'` and never enrol in `conformance.ts`, and nothing fails.
 * That is exactly how the divergence this issue is about survived — the kubectl-era
 * transports' fast tiers went unrecorded, so `extension.ts`'s `opts.transport` could
 * override both tiers and silently remove one.
 *
 * So the discipline needs the second half: every transport that MAKES the claim must be
 * held to the battery. This test is the link between the two lists. It is the same
 * source-reading, loud-throw idiom output-cap-coupling.test.ts and
 * refusal-vocabulary-coupling.test.ts use for the Go constants — applied within one
 * package here, because the thing being pinned is likewise a correspondence no type
 * expresses: N declaration sites against N enrolments.
 */

/** A `fastTier:` declaration site, as `{ file, exported constructor }`. */
interface Declarer {
  file: string;
  /** The exported function that returns the transport, e.g. `GrpcRelayTransport`. */
  name: string;
}

/**
 * Every `src/*.ts` that declares a LITERAL `fastTier`, paired with the exported
 * constructor in it. A literal is the signal that the file is a transport implementation
 * rather than a wrapper: `capacity-latch.ts` forwards (`fastTier: transport.fastTier`) and
 * is therefore not a declarer — its forwarding is pinned by the battery itself, which runs
 * `createCapacityLatch().watch()` over every transport.
 *
 * Loud-throw, for the reason the Go readers are: a renamed field or a reformatted literal
 * must fail the extraction rather than yield an empty list and pass every assertion below
 * vacuously — a vacuous pass here would be precisely the silence the test exists to break.
 */
const readDeclarers = (): Declarer[] => {
  const out: Declarer[] = [];
  for (const file of readdirSync(SRC)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    const lines = readFileSync(resolve(SRC, file), 'utf8').split('\n');
    // The ENCLOSING export, i.e. the last one at or above the declaration — not the
    // file's first. A transport file that opens with a helper would otherwise name a
    // helper no conformance file imports and report a failure that is the reader's own,
    // which is worse than no test: it trains the next person to edit the expectation.
    // `transport.ts` holds the type and no implementation, so it declares no literal
    // and never reaches here.
    let enclosing: string | undefined;
    for (const line of lines) {
      const fn = /^export function (\w+)\(/.exec(line);
      if (fn) enclosing = fn[1];
      if (!/fastTier:\s*'(?:persistent-channel|per-call-exec)'/.test(line)) continue;
      if (!enclosing) {
        throw new Error(
          `${file} declares a literal fastTier with no \`export function\` above it — ` +
            'transport constructor renamed, or declared as a const?',
        );
      }
      if (!out.some((d) => d.name === enclosing)) out.push({ file, name: enclosing });
    }
  }
  if (out.length < 1) {
    throw new Error(
      `found ${out.length} literal fastTier declarations under src/ — field renamed, ` +
        'or FastTier gained a member this reader does not know?',
    );
  }
  return out;
};

/** Every constructor the conformance battery is actually run against. */
const readEnrolled = (): Set<string> => {
  const out = new Set<string>();
  for (const file of readdirSync(HERE).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(resolve(HERE, file), 'utf8');
    // The battery's own definition, not a run of it.
    if (!/\brunConformance\(/.test(src) || file === 'conformance.ts') continue;
    for (const m of src.matchAll(/^import \{([^}]*)\} from '\.\.\/src\/([\w-]+)\.js';$/gms)) {
      for (const spec of m[1].split(',')) {
        const bare = spec
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0];
        if (bare) out.add(bare);
      }
    }
  }
  if (out.size === 0) {
    throw new Error(
      'no runConformance call site imported anything from ../src — import form changed?',
    );
  }
  return out;
};

describe('fast-tier availability is pinned per transport (#245)', () => {
  it('holds every transport that declares a fastTier to the conformance battery', () => {
    // The assertion the issue asks for: "a fourth transport cannot silently ship without
    // one". Reported as the full list rather than per-case, so a failure names the
    // transport that was added and the file that must run the battery over it.
    const missing = readDeclarers().filter((d) => !readEnrolled().has(d.name));
    expect(
      missing.map((d) => `${d.name} (src/${d.file})`),
      'these transports declare a fastTier but no test/*.ts runs runConformance over them',
    ).toEqual([]);
  });

  it('the battery asserts the declared fast tier, rather than taking the declaration', () => {
    // The guard on the guard. The test above proves each transport is ENROLLED; it cannot
    // see whether enrolment checks anything. With `expect(transport.fastTier)` deleted from
    // conformance.ts, `TransportCapabilities.fastTier` would become a field every factory
    // fills in and nothing reads — still type-correct, still three enrolments, and the
    // declaration back to being a comment. Both assertions are named: the raw transport,
    // and the one a harness turn actually reads, off the capacity latch's wrapper.
    const battery = readFileSync(resolve(HERE, 'conformance.ts'), 'utf8');
    expect(battery).toContain('expect(transport.fastTier).toBe(caps.fastTier)');
    expect(battery).toContain(
      'expect(createCapacityLatch().watch(transport).fastTier).toBe(caps.fastTier)',
    );
  });
});
