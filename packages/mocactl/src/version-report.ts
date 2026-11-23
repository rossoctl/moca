import type { Discovery } from './api/types.js';
import { remoteVersion } from './core/banner.js';
import { sanitizeRemote } from './core/sanitize.js';
import { sleep } from './core/time.js';

/** A control plane `--version` asks for its version: where it is, and its public discovery. */
export interface VersionTarget {
  label: string;
  url: string;
  discovery: (opts: { signal: AbortSignal }) => Promise<Pick<Discovery, 'version'>>;
}

/**
 * `mocactl --version`'s lines after the first (`CLI version: V`, this build's, which stays the
 * only line where no control plane is configured). One line per configured control plane, asked in parallel: its version,
 * or `unreachable` when it did not answer within `timeoutMs`, or `version unknown` when it
 * answered without advertising one (a control plane that predates advertising it).
 */
export async function versionReport(
  targets: VersionTarget[],
  opts: { timeoutMs?: number } = {},
): Promise<string[]> {
  if (targets.length === 0) return [];
  const timeoutMs = opts.timeoutMs ?? 2000;
  const controller = new AbortController();
  try {
    // The deadline's timer is cleared by the abort below: left running, it would hold the
    // process open for the whole timeout after every control plane had answered.
    const deadline = sleep(timeoutMs, controller.signal).then(
      () => undefined,
      () => undefined,
    );
    const answers = await Promise.all(
      targets.map((t) =>
        Promise.race([
          t
            .discovery({ signal: controller.signal })
            .then((d) =>
              typeof d.version === 'string'
                ? (remoteVersion(d.version) ?? 'version unknown')
                : 'version unknown',
            )
            .catch(() => undefined),
          deadline,
        ]),
      ),
    );
    const width = Math.max(...targets.map((t) => t.label.length)) + 1;
    return targets.map(
      (t, i) =>
        `${(t.label + ':').padEnd(width)} ${answers[i] ?? 'unreachable'} (${sanitizeRemote(t.url)})`,
    );
  } finally {
    // A fetch that lost the race must not keep the process alive.
    controller.abort();
  }
}
