import {
  ExecAbortedError,
  execFailureText,
  ExecMachineryError,
  ExecRefusedError,
  ProcessError,
  processNameProblem,
  processRow,
  processSelector,
  q,
  shownProcessId,
  startedProcessText,
  type LeaseEvent,
  type ProcessSelector,
  type TrackedProcessView,
} from '@moca/sandbox-client';
import { ApiError } from '../api/errors.js';
import { sanitizeRemote } from '../core/sanitize.js';
import { failed, SBX_EXIT, type SbxCtx } from './commands.js';
import {
  jwtMode,
  openExec,
  sandboxFailureText,
  type ExecFactory,
  type OpenedExec,
} from './exec.js';
import { printNotices } from './notices.js';

/**
 * `mocactl sbx proc` (lease-mode spec §7, plan 5): the tracked processes of a `lease+processes`
 * sandbox, from a terminal (the live smoke drives them), as the MCP server's process tools give
 * them to an agent. No TTY rule: none of them changes the mode. Results go to stdout; notices and
 * diagnostics to stderr. Exit 0, 1 on a refusal or failure, 130 on Ctrl-C (P5-R31).
 */

const PROC_SUBS = ['start', 'ls', 'logs', 'stop'] as const;
export type ProcSub = (typeof PROC_SUBS)[number];

export type ProcArgs =
  | { sub: 'start'; command: string; name?: string; cwd?: string }
  | { sub: 'ls' }
  | { sub: 'logs'; process: ProcessSelector; tail?: number; raw?: boolean }
  | { sub: 'stop'; process: ProcessSelector; signal?: string };

/** The flags that belong to one proc subcommand each (`--name` also to create and up). */
export const PROC_FLAG_OWNER = {
  name: 'start',
  cwd: 'start',
  tail: 'logs',
  raw: 'logs',
  signal: 'stop',
} as const satisfies Record<string, ProcSub>;

/** ProcessArgs.tail is a uint32: the most lines `--tail` may ask for (PR #814 review). */
const MAX_TAIL = 0xffffffff;

/** One process as `proc ls`, `proc stop` and `get` show it: `processRow`, sanitized. */
export const processRowText = (v: TrackedProcessView): string => sanitizeRemote(processRow(v));

/**
 * A process as notices name it (spec §7): `<name> (pid <n>)`, its id (`p<id>`) when it has no
 * name; sanitized.
 */
export const processDisplay = (v: { id: string; name: string; pid: number }): string =>
  `${sanitizeRemote(v.name || shownProcessId(v.id))} (pid ${v.pid})`;

/**
 * `proc SUB ...`'s arguments: `rest` the positionals after SUB and before `--`, `command` those
 * after `--` (undefined without one). Returns the arguments and the sandbox positional, or the
 * line saying why they are not (a usage error).
 */
export function parseProcArgs(
  sub: string | undefined,
  rest: string[],
  command: string[] | undefined,
  v: {
    name?: string;
    cwd?: string;
    tail?: string;
    raw?: boolean;
    signal?: string;
    json?: boolean;
  },
): { args: ProcArgs; sandbox?: string } | string {
  if (sub === undefined)
    return `proc needs a subcommand: ${PROC_SUBS.slice(0, -1).join(', ')} or stop`;
  if (!(PROC_SUBS as readonly string[]).includes(sub)) {
    return `unknown proc command '${sanitizeRemote(sub)}'`;
  }
  const s = sub as ProcSub;
  for (const [flag, owner] of Object.entries(PROC_FLAG_OWNER)) {
    if (v[flag as keyof typeof PROC_FLAG_OWNER] !== undefined && owner !== s) {
      return `--${flag} only applies to proc ${owner}`;
    }
  }
  if (v.json && s !== 'ls') return `proc ${s} has no --json output`;
  if (s !== 'start' && command !== undefined) return `too many arguments for proc ${s}`;
  const tooMany = `too many arguments for proc ${s}`;
  const one = (xs: string[]) => (xs[0] !== undefined ? { sandbox: xs[0] } : {});
  switch (s) {
    case 'start': {
      if (!command?.length) return 'proc start needs a command: mocactl sbx proc start [ID] -- CMD';
      if (rest.length > 1) return tooMany;
      // The guest's name rule, id-shaped names refused (P5-R33), in the guest's words.
      const bad = v.name !== undefined ? processNameProblem(v.name) : undefined;
      if (bad !== undefined) return `invalid name: ${sanitizeRemote(bad)}`;
      // Each word quoted, as `run` quotes its CMD: `-- sh -c '...'` for shell syntax.
      return {
        args: {
          sub: 'start',
          command: command.map(q).join(' '),
          ...(v.name !== undefined ? { name: v.name } : {}),
          ...(v.cwd !== undefined ? { cwd: v.cwd } : {}),
        },
        ...one(rest),
      };
    }
    case 'ls':
      return rest.length > 1 ? tooMany : { args: { sub: 'ls' }, ...one(rest) };
    case 'logs':
    case 'stop': {
      const [who, ...sandbox] = rest;
      if (who === undefined || !who.trim()) {
        return `proc ${s} needs a process: its name, or its id (p<n>)`;
      }
      if (sandbox.length > 1) return tooMany;
      const process = processSelector(who);
      if (s === 'stop') {
        return {
          args: { sub: 'stop', process, ...(v.signal !== undefined ? { signal: v.signal } : {}) },
          ...one(sandbox),
        };
      }
      let tail: number | undefined;
      if (v.tail !== undefined) {
        tail = /^\d+$/.test(v.tail.trim()) ? Number(v.tail.trim()) : Number.NaN;
        if (!Number.isSafeInteger(tail) || tail < 1 || tail > MAX_TAIL) {
          return `--tail must be a whole number of lines, from 1 to ${MAX_TAIL} (got '${sanitizeRemote(v.tail)}')`;
        }
      }
      return {
        args: {
          sub: 'logs',
          process,
          ...(tail !== undefined ? { tail } : {}),
          ...(v.raw === true ? { raw: true } : {}),
        },
        ...one(sandbox),
      };
    }
  }
}

/** The events an error carries (spec §5): said before the failure, as `run` says them. */
function carried(err: unknown): LeaseEvent[] {
  return err instanceof ProcessError ||
    err instanceof ExecMachineryError ||
    err instanceof ExecRefusedError ||
    err instanceof ExecAbortedError
    ? err.lease
    : [];
}

/**
 * The exit for a failed proc call, said in a person's words (the CLI audience). `sent`: the
 * process Exec went out, so an interrupted start or stop may still have acted.
 */
function procFailed(c: SbxCtx, id: string, sub: ProcSub, err: unknown, sent: boolean): number {
  if (c.signal?.aborted && !sent) {
    if (sub === 'start' || sub === 'stop') c.io.err('sbx: interrupted: nothing was sent');
    return SBX_EXIT.interrupted;
  }
  if (err instanceof ApiError) return failed(c, err);
  if (c.signal?.aborted) {
    if (sub === 'start' || sub === 'stop') {
      c.io.err(
        `sbx: interrupted: the process may have ${sub === 'start' ? 'started' : 'stopped'}; mocactl sbx proc ls shows it`,
      );
    }
    return SBX_EXIT.interrupted;
  }
  const text = execFailureText(err, { audience: 'cli', sandboxId: id });
  c.io.err(`sbx: ${text !== undefined ? sanitizeRemote(text) : sandboxFailureText(err)}`);
  return SBX_EXIT.failed;
}

/** The §7 refusal for a sandbox below lease+processes, as a person is told it. */
const notEnabled = (id: string): string =>
  execFailureText(new ProcessError('processes_not_enabled', '', ''), {
    audience: 'cli',
    sandboxId: id,
  })!;

/**
 * `mocactl sbx proc SUB` on sandbox `id`. The token minted to open the connection carries the
 * sandbox's mode: below lease+processes the call is refused here with the §7 text, unsent, as the
 * MCP server refuses it (P5-R27); the relay and the worker refuse it too.
 */
export async function cmdProc(
  c: SbxCtx,
  id: string,
  a: ProcArgs,
  factory?: ExecFactory,
  o: { stdoutIsTTY?: boolean } = {},
): Promise<number> {
  let x: OpenedExec;
  try {
    x = await openExec(c.api, id, factory, c.signal ? { signal: c.signal } : {});
  } catch (err) {
    return procFailed(c, id, a.sub, err, false);
  }
  // Set just before the process Exec goes out: what an interrupt may have left behind.
  let sent = false;
  const opts = c.signal ? { signal: c.signal } : {};
  try {
    if (jwtMode(x.token.token) !== 'lease+processes') {
      c.io.err(`sbx: ${sanitizeRemote(notEnabled(id))}`);
      return SBX_EXIT.failed;
    }
    switch (a.sub) {
      case 'start': {
        const args = {
          command: a.command,
          ...(a.name !== undefined ? { name: a.name } : {}),
          ...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
        };
        sent = true;
        const r = await x.process('start', args, opts);
        printNotices(c, id, r.lease);
        const p = r.result;
        // `<id> <name> pid <n>`, or `<id> pid <n>` for an unnamed one (final review M3).
        c.io.out(`${sanitizeRemote(startedProcessText(p))} pid ${p.pid}\n`);
        return SBX_EXIT.ok;
      }
      case 'ls': {
        sent = true;
        const r = await x.process('list', {}, opts);
        printNotices(c, id, r.lease);
        if (c.json) c.io.out(JSON.stringify(r.result) + '\n');
        else if (r.result.length === 0) c.io.out('no tracked processes\n');
        else for (const v of r.result) c.io.out(processRowText(v) + '\n');
        return SBX_EXIT.ok;
      }
      case 'logs': {
        sent = true;
        const r = await x.process(
          'logs',
          { ...a.process, ...(a.tail !== undefined ? { tail: a.tail } : {}) },
          opts,
        );
        printNotices(c, id, r.lease);
        // Unlike `run`'s output, which the user just asked for, this replays later, out of
        // band, what a process the agent started wrote: on a terminal its control sequences
        // (an OSC 52 clipboard write, OSC 8 links, a title) are removed, `\n` and `\t` kept.
        // Piped, or with --raw, it is the process's bytes as they are (PR #814 review).
        const text = o.stdoutIsTTY === true && a.raw !== true ? sanitizeRemote(r.result) : r.result;
        if (text) c.io.out(text);
        return SBX_EXIT.ok;
      }
      case 'stop': {
        sent = true;
        const r = await x.process(
          'stop',
          { ...a.process, ...(a.signal !== undefined ? { signal: a.signal } : {}) },
          opts,
        );
        printNotices(c, id, r.lease);
        c.io.out(processRowText(r.result) + '\n');
        return SBX_EXIT.ok;
      }
    }
  } catch (err) {
    printNotices(c, id, carried(err));
    return procFailed(c, id, a.sub, err, sent);
  } finally {
    x.close();
  }
}
