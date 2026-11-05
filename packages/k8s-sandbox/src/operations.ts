import type {
  BashOperations,
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from '@earendil-works/pi-coding-agent';
import type { SandboxContext } from './transport.js';
import type { ExecInPod } from './transport.js';
import { mapPath, shQuote } from './paths.js';
import { DEFAULT_OUTPUT_CAP } from './transport.js';
import { sandboxEnv } from './sandbox-env.js';

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function mapper(cfg: SandboxContext) {
  return (p: string) => shQuote(mapPath(p, cfg.headCwd, cfg.podCwd));
}

export function createPodReadOps(exec: ExecInPod, cfg: SandboxContext): ReadOperations {
  const q = mapper(cfg);
  return {
    readFile: async (p) => {
      const r = await exec(`cat ${q(p)}`);
      // Never hand back bytes we cannot vouch for. Pi's Edit tool is
      // read-whole-file → replace → write-whole-file, so returning a partial read
      // would write the truncation — marker text included — back over the real
      // file.
      if (r.truncated) {
        // pi-fork's read.ts reads the WHOLE file and only then applies offset/limit, so
        // a file over the cap is unreachable through Read/Edit entirely — not merely
        // truncated. Name the size so the model can choose a range, and point at the
        // one tool that can still get there. Error path only, so the extra exec is free.
        const stat = await exec(`stat -c %s ${q(p)}`).catch(() => null);
        const size = stat && stat.exitCode === 0 ? stat.stdout.toString().trim() : null;
        throw new Error(
          `Read exceeds the ${DEFAULT_OUTPUT_CAP} byte sandbox output cap` +
            `${size ? ` (file is ${size} bytes)` : ''}: ${p}. ` +
            `Read a range with bash instead, e.g. sed -n '1,500p' <file>.`,
        );
      }
      if (r.exitCode === null) {
        throw new Error(`Read failed in pod (cat signalled; no exit status): ${p}`);
      }
      if (r.exitCode !== 0) {
        throw new Error(`Read failed in pod (cat exited ${r.exitCode}): ${p}`);
      }
      return r.stdout;
    },
    access: async (p) => {
      const r = await exec(`test -r ${q(p)}`);
      if (r.exitCode !== 0) throw new Error(`File not readable in pod: ${p}`);
    },
    detectImageMimeType: async (p) => {
      const r = await exec(`file --mime-type -b ${q(p)}`);
      const mime = r.stdout.toString().trim();
      return IMAGE_MIMES.includes(mime) ? mime : null;
    },
  };
}

export function createPodWriteOps(exec: ExecInPod, cfg: SandboxContext): WriteOperations {
  const q = mapper(cfg);
  return {
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString('base64');
      const r = await exec(`base64 -d > ${q(p)}`, { stdin: Buffer.from(b64) });
      if (r.exitCode !== 0) throw new Error(`Write failed in pod: ${p}`);
    },
    mkdir: async (dir) => {
      const r = await exec(`mkdir -p ${q(dir)}`);
      if (r.exitCode !== 0) throw new Error(`mkdir failed in pod: ${dir}`);
    },
  };
}

export function createPodEditOps(exec: ExecInPod, cfg: SandboxContext): EditOperations {
  const read = createPodReadOps(exec, cfg);
  const write = createPodWriteOps(exec, cfg);
  const q = mapper(cfg);
  return {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: async (p) => {
      const r = await exec(`test -r ${q(p)} && test -w ${q(p)}`);
      if (r.exitCode !== 0) throw new Error(`File not read-writable in pod: ${p}`);
    },
  };
}

export function createPodBashOps(exec: ExecInPod, cfg: SandboxContext): BashOperations {
  const q = mapper(cfg);
  return {
    // Pi passes `env` only to the bash tool, and it is the WHOLE harness process environment. Only
    // sandboxEnv()'s allowlist crosses (MI1 §5 R1); everything else stays in the harness. Keys are
    // still validated as POSIX names so the prefix can't be injected; values remain safe via shQuote.
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const pairs = Object.entries(sandboxEnv(env))
        .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        .map(([k, v]) => `${k}=${shQuote(v)}`);
      const wrapped = pairs.length
        ? `cd ${q(cwd)} && env ${pairs.join(' ')} bash -c ${shQuote(command)}`
        : `cd ${q(cwd)} && ${command}`; // M2's exact form — unchanged when no env
      const r = await exec(wrapped, { onData, signal, timeout });
      // A cap trip means the command was SIGKILLed mid-flight with no exit status. Pi
      // treats a null code as non-failing (bash.ts:397), so returning the seam's null
      // here told the model a killed command had completed (#181). 137 = 128+9 is the
      // conventional SIGKILL status and is accurate — the command was killed by signal 9
      // — and it routes through Pi's own failure path, which appends the streamed output
      // tail. A bare throw would lose that tail: bash.ts applies appendStatus only for
      // "aborted"/"timeout:" messages and bare-rethrows anything else.
      //
      // Caveat: on the kubectl paths we SIGKILL our local client, so the in-pod process
      // dies by EPIPE rather than by our signal (#185, spec §8's declared mechanisms).
      if (r.truncated) return { exitCode: 137 };
      return { exitCode: r.exitCode };
    },
  };
}

export function createPodLsOps(exec: ExecInPod, cfg: SandboxContext): LsOperations {
  const q = mapper(cfg);
  return {
    exists: async (p) => (await exec(`test -e ${q(p)}`)).exitCode === 0,
    stat: async (p) => {
      const r = await exec(`test -e ${q(p)} && (test -d ${q(p)} && echo DIR || echo FILE)`);
      if (r.exitCode !== 0) throw new Error(`Path not found in pod: ${p}`);
      const isDir = r.stdout.toString().trim() === 'DIR';
      return { isDirectory: () => isDir };
    },
    readdir: async (p) => {
      const r = await exec(`ls -1A ${q(p)}`);
      // A directory with enough entries (~200k) can cross the output cap just like any
      // other unbounded listing. A cap trip means what came back is not a trustworthy
      // directory listing — it may even contain OUTPUT_TRUNCATED_MARKER as a bogus entry.
      if (r.truncated) {
        throw new Error(
          `readdir exceeds the ${DEFAULT_OUTPUT_CAP} byte sandbox output cap: ${p}. ` +
            `List a subdirectory, or use bash with \`ls -1A | head -n <n>\`.`,
        );
      }
      if (r.exitCode !== 0) throw new Error(`readdir failed in pod: ${p}`);
      return r.stdout
        .toString()
        .split('\n')
        .filter((x) => x.length > 0);
    },
  };
}

export function createPodFindOps(exec: ExecInPod, cfg: SandboxContext): FindOperations {
  const q = mapper(cfg);
  return {
    exists: async (p) => (await exec(`test -e ${q(p)}`)).exitCode === 0,
    // `rg --files --hidden` lists files under cwd, honouring .gitignore (verified on the
    // pod's ripgrep 14.1.0, and re-verified on 15.2.0 — the version the leaf sandbox images
    // vendor — where both nuances below hold unchanged). Nuance: gitignored DIRECTORIES
    // (e.g. node_modules/, dist/) are pruned and stay excluded even though an explicit -g
    // matches files inside them; but an individually-gitignored FILE matching the positive
    // -g <pattern> IS re-included (the glob whitelist-overrides a file-level ignore) — a
    // minor divergence from Pi's `fd --glob`. Pi's `ignore` list is applied as negated
    // globs (-g '!<ig>') and always excludes its entries. --hidden keeps
    // dotfiles in view. Paths come back relative to cwd; strip any leading "./".
    glob: async (pattern, cwd, { ignore, limit }) => {
      const globs = [`-g ${shQuote(pattern)}`, ...ignore.map((ig) => `-g ${shQuote(`!${ig}`)}`)];
      const r = await exec(
        `cd ${q(cwd)} && rg --files --hidden ${globs.join(' ')} | head -n ${limit}; ` +
          `rc=\${PIPESTATUS[0]}; [ "\$rc" = 0 ] || [ "\$rc" = 1 ] || [ "\$rc" = 141 ] || exit "\$rc"`,
      );
      // Two independent concerns, checked in order.
      //
      // The shell guard above surfaces `rg`'s own status, which piping to `head` would
      // otherwise mask (#187): rc 0 and rc 1 (no matches) are both success, 141 is `head`
      // closing the pipe once it has its limit, and anything else propagates as the exec's
      // status. That is about the SEARCH failing.
      //
      // Truncation is a property of the SEAM, not of rg's exit code, so it has its own
      // flag and is checked first — a cap trip can happen while rg itself is perfectly
      // happy, and reporting it as "rg exited N" would blame the wrong component.
      if (r.truncated) {
        // What came back can contain OUTPUT_TRUNCATED_MARKER as a bogus path entry, so
        // it cannot be handed to the model as a file list.
        throw new Error(
          `glob exceeds the ${DEFAULT_OUTPUT_CAP} byte sandbox output cap: ${pattern}. ` +
            `Narrow the pattern or lower the limit.`,
        );
      }
      if (r.exitCode === null) {
        throw new Error(`glob failed in pod (rg signalled; no exit status): ${pattern}`);
      }
      if (r.exitCode !== 0 && r.exitCode !== 1) {
        throw new Error(`glob failed in pod (rg exited ${r.exitCode}): ${pattern}`);
      }
      return r.stdout
        .toString()
        .split('\n')
        .filter((x) => x.length > 0)
        .map((rel) => rel.replace(/^\.\//, ''));
    },
  };
}
