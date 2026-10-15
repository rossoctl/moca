import { posix } from 'node:path';
import type {
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from '@earendil-works/pi-coding-agent';
import type { ExecInPod } from '@moca/k8s-sandbox';

/**
 * On the microVM tier every Exec is a fresh VM (~150 ms on the rig), so the probes Pi's tools make
 * before the real work dominate. Measured on the rig, 2026-10-09: read 3 Execs, edit 3, write 2,
 * find 2, ls 3 + one per entry. These wrappers make each one Exec (edit two: read, then write).
 * The pod ops stay the source of the real work; only the probes are dropped or merged.
 */

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** A failing cat already reports a missing or unreadable file, so the access probe goes. */
const noAccessProbe = async () => {};

export function readOps(pod: ReadOperations): ReadOperations {
  return {
    ...pod,
    access: noAccessProbe,
    detectImageMimeType: async (p) => IMAGE_EXT[posix.extname(p).toLowerCase()] ?? null,
  };
}

export function editOps(pod: EditOperations): EditOperations {
  return { ...pod, access: noAccessProbe };
}

/** mkdir -p folded into the write itself. */
export function writeOps(exec: ExecInPod): WriteOperations {
  return {
    mkdir: async () => {},
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString('base64');
      const r = await exec(`mkdir -p ${shQuote(posix.dirname(p))} && base64 -d > ${shQuote(p)}`, {
        stdin: Buffer.from(b64),
      });
      if (r.exitCode !== 0) throw new Error(`Write failed in the sandbox: ${p}`);
    },
  };
}

/** The glob's own `cd` fails on a missing path, so the exists probe goes. */
export function findOps(pod: FindOperations): FindOperations {
  return { ...pod, exists: async () => true };
}

/**
 * One listing answers all of Pi's ls calls: exists(dir), stat(dir), readdir(dir) and a stat per
 * entry. `ls -p` marks directories with a trailing slash.
 */
export function lsOps(exec: ExecInPod): LsOperations {
  const listings = new Map<
    string,
    Promise<{ kind: 'D' | 'F' | 'N'; entries: Map<string, boolean> }>
  >();
  const list = (dir: string) => {
    let got = listings.get(dir);
    if (!got) {
      const q = shQuote(dir);
      got = exec(
        `if [ -d ${q} ]; then echo D; ls -1Ap -- ${q}; elif [ -e ${q} ]; then echo F; else echo N; fi`,
      ).then((r) => {
        if (r.truncated) throw new Error(`listing exceeds the sandbox output cap: ${dir}`);
        if (r.exitCode !== 0)
          throw new Error(`ls failed in the sandbox (exit ${r.exitCode}): ${dir}`);
        const [kind, ...lines] = r.stdout
          .toString()
          .split('\n')
          .filter((l) => l.length > 0);
        const entries = new Map(lines.map((l) => [l.replace(/\/$/, ''), l.endsWith('/')]));
        return { kind: kind as 'D' | 'F' | 'N', entries };
      });
      listings.set(dir, got);
    }
    return got;
  };
  return {
    exists: async (p) => (await list(p)).kind !== 'N',
    stat: async (p) => {
      const parent = listings.get(posix.dirname(p));
      if (parent) {
        const isDir = (await parent).entries.get(posix.basename(p));
        if (isDir !== undefined) return { isDirectory: () => isDir };
      }
      const { kind } = await list(p);
      if (kind === 'N') throw new Error(`Path not found in the sandbox: ${p}`);
      return { isDirectory: () => kind === 'D' };
    },
    readdir: async (p) => [...(await list(p)).entries.keys()],
  };
}
