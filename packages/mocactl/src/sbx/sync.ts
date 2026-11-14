import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ApiError, TOKEN_CODES } from '../api/errors.js';
import { describeError } from '../core/messages.js';
import { sanitizeRemote } from '../core/sanitize.js';
import {
  CLAUDE_PROMPT_PICK,
  ConfigConflict,
  cortexMode,
  takeBackAgentConfig,
  writeAgentConfig,
} from './agent-config.js';
import {
  agentopProblem,
  CORTEX_INSTALL,
  installMocaSandbox,
  MOCA_SANDBOX,
  runAgentop,
  type AgentopExec,
} from './agentop.js';
import type { SbxSandbox } from './api.js';
import { createWaitingForActivation, failed, SBX_EXIT, type SbxCtx } from './commands.js';
import {
  execFailed,
  openExec,
  sandboxFailureText,
  type ExecFactory,
  type OpenedExec,
} from './exec.js';
import {
  PushError,
  advanceBaseline,
  applyPatch,
  bindingUrl,
  capture,
  hasUnpulled,
  planPush,
  pushTree,
  repoId,
  UnpulledError,
  writeBinding,
  type PushPlan,
} from './push.js';

/**
 * `mocactl sbx up`, `push` and `pull` (SBX0 §6.1, §6.2): the commands over push.ts. Every message
 * is on stderr; stdout carries only what a script reads (the sandbox id from `up`, the patch from
 * `pull`).
 */

/** The template `up` and `create` use when none is given (spec §6.1). */
export const DEFAULT_TEMPLATE = 'default';

export const UNPULLED_TEXT = 'the sandbox has changes not yet pulled';

/** What `up` says in Cortex mode, every time: the blocking needs Claude Code to go through Cortex. */
export const CORTEX_NOTE =
  "Cortex blocks local tools in this repo's Claude Code sessions; Claude Code must reach the " +
  'model through Cortex (agentop configure claude-code).';

const mib = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;
const when = (epochS: number) => new Date(epochS * 1000).toISOString();
const say = (c: SbxCtx, s: string) => c.io.err(`sbx: ${sanitizeRemote(s)}`);

/** Runs `fn` on one sandbox's Exec function, closing it after; failures become exit codes. */
async function withExec(
  c: SbxCtx,
  id: string,
  factory: ExecFactory | undefined,
  fn: (x: OpenedExec) => Promise<number>,
): Promise<number> {
  let x: OpenedExec;
  try {
    x = await openExec(c.api, id, factory);
  } catch (err) {
    return execFailed(c, err);
  }
  try {
    return await fn(x);
  } catch (err) {
    if (err instanceof PushError) {
      say(c, err.message);
      return SBX_EXIT.failed;
    }
    return execFailed(c, err);
  } finally {
    x.close();
  }
}

/** The plan, with what was left out said; or the exit code after saying why it was refused. */
async function plan(
  c: SbxCtx,
  root: string,
  o: { includeSecrets?: boolean; maxPush?: number; cwd?: string },
): Promise<PushPlan | number> {
  let p: PushPlan;
  try {
    p = await planPush(root, o);
  } catch (err) {
    if (!(err instanceof PushError)) throw err;
    say(c, err.message);
    return SBX_EXIT.failed;
  }
  // Said before anything is sent: run from a subdirectory, `up` and `push` still send the whole
  // work tree (the sandbox belongs to the working tree, not the directory), and the file count
  // alone does not make that obvious (#611).
  if (o.cwd !== undefined && resolve(o.cwd) !== resolve(root)) {
    say(
      c,
      `the whole work tree at ${root} (${p.files} files) is what gets pushed, not just the current directory`,
    );
  }
  if (p.excludedSecrets.length) {
    say(
      c,
      `not pushed, as they may hold secrets (--include-secrets pushes them): ${p.excludedSecrets.join(', ')}`,
    );
  }
  for (const s of p.skipped) say(c, `not pushed: ${s}`);
  return p;
}

async function doPush(
  c: SbxCtx,
  x: OpenedExec,
  id: string,
  p: PushPlan,
  guard: boolean,
): Promise<void> {
  await pushTree(x.exec, p, undefined, {
    guard,
    ...(c.signal ? { signal: c.signal } : {}),
    onChunk: (i, n) => {
      if (n > 1) c.io.err(`pushing part ${i} of ${n}`);
    },
  });
  c.io.err(`pushed ${p.files} files (${mib(p.bytes)}) to ${id}`);
}

export interface PushFlags {
  force: boolean;
  includeSecrets: boolean;
  maxPush?: number;
  /**
   * The directory `up`/`push` was run from, when known: not a CLI flag, but the plan says when it
   * differs from the work-tree root (#611). Both sides are `resolve`d before the comparison:
   * `repoRoot` returns git's `--show-toplevel` verbatim, which on Windows is forward-slashed where
   * `resolve` yields backslashes.
   */
  cwd?: string;
}

/** `mocactl sbx push`: refused while the sandbox holds changes not yet pulled, unless `--force`. */
export async function cmdPush(
  c: SbxCtx,
  root: string,
  id: string,
  f: PushFlags,
  factory?: ExecFactory,
): Promise<number> {
  const p = await plan(c, root, f);
  if (typeof p === 'number') return p;
  return withExec(c, id, factory, async (x) => {
    try {
      // Without --force, the unpulled check runs in the Exec that empties the workspace.
      await doPush(c, x, id, p, !f.force);
    } catch (err) {
      if (!(err instanceof UnpulledError)) throw err;
      say(c, `${UNPULLED_TEXT}: run mocactl sbx pull, or push --force to discard them`);
      return SBX_EXIT.failed;
    }
    return SBX_EXIT.ok;
  });
}

export interface PullFlags {
  apply: boolean;
  /** A file to write the patch to; `-` is stdout. */
  out?: string;
  /** Where `--apply` applies: the repository root. */
  root?: string;
}

/**
 * `mocactl sbx pull`: the patch on stdout (or `-o FILE`). With `--apply`, applied in the local
 * repository, and only after a clean apply is the sandbox's baseline advanced (spec §6.2).
 */
export async function cmdPull(
  c: SbxCtx,
  id: string,
  f: PullFlags,
  cwd: string,
  factory?: ExecFactory,
): Promise<number> {
  return withExec(c, id, factory, async (x) => {
    const { patch, tree } = await capture(x.exec, undefined, { signal: c.signal });
    if (patch.length === 0) {
      c.io.err('nothing to pull');
      return SBX_EXIT.ok;
    }
    if (f.out !== undefined && f.out !== '-') {
      // 0600 when created: the patch is the repository's code, for no one else on the machine.
      writeFileSync(resolve(cwd, f.out), patch, { mode: 0o600 });
      c.io.err(`wrote the sandbox's changes to ${f.out} (${patch.length} bytes)`);
    } else if (f.out === '-' || !f.apply) {
      if (c.io.outBytes) c.io.outBytes(patch);
      else c.io.out(patch.toString());
    }
    if (!f.apply) return SBX_EXIT.ok;
    const touched = await applyPatch(f.root!, patch, { warn: (w) => say(c, w) });
    try {
      await advanceBaseline(x.exec, undefined, tree, { signal: c.signal });
    } catch (err) {
      say(
        c,
        `applied the sandbox's changes here, but advancing its baseline failed, so the next pull ` +
          `shows them again (mocactl sbx push --force makes the sandbox match this tree): ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return SBX_EXIT.failed;
    }
    c.io.err(
      `applied the sandbox's changes to ${touched.length} ${touched.length === 1 ? 'file' : 'files'} ` +
        `(${patch.length} bytes of patch)`,
    );
    return SBX_EXIT.ok;
  });
}

export interface UpFlags extends PushFlags {
  /** `--template`, if given: a reused sandbox must have it. */
  template?: string;
  name?: string;
  noAgentConfig: boolean;
  /** `--cortex`: Cortex's moca-sandbox script blocks local tools, so none are denied. */
  cortex?: boolean;
  /** The id in `.sbx/sandbox.json`, if valid. */
  boundId?: string;
}

function stateText(s: SbxSandbox): string {
  return s.state === 'terminated' && s.reason ? `terminated (${s.reason})` : s.state;
}

/**
 * The sandbox `up` uses: the bound one if ready; else the user's newest ready one labelled
 * `project=<repo id>`; else a new one. A reused sandbox must have `--template` when it was given.
 */
async function findOrCreate(
  c: SbxCtx,
  rid: string,
  f: UpFlags,
): Promise<{ sandbox: SbxSandbox; reused: boolean } | number> {
  const fits = (s: SbxSandbox) => f.template === undefined || s.template === f.template;
  if (f.boundId) {
    let bound: SbxSandbox | undefined;
    try {
      bound = await c.api.getSandbox(f.boundId);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'sandbox_not_found')) return failed(c, err);
      say(c, `the bound sandbox ${f.boundId} no longer exists; finding or creating another`);
    }
    if (bound?.state === 'ready') {
      if (!fits(bound)) {
        say(
          c,
          `the bound sandbox ${bound.id} has template ${bound.template}, not ${f.template}: ` +
            `pull its work, remove it (mocactl sbx rm ${bound.id}), or run up without --template`,
        );
        return SBX_EXIT.failed;
      }
      return { sandbox: bound, reused: true };
    }
    if (bound) {
      say(c, `the bound sandbox ${bound.id} is ${stateText(bound)}; finding or creating another`);
    }
  }
  try {
    const mine = (await c.api.listSandboxes())
      .filter((s) => s.state === 'ready' && s.labels?.project === rid && fits(s))
      .sort((a, b) => b.createdAt - a.createdAt);
    if (mine[0]) {
      c.io.err(`reusing ${sanitizeRemote(mine[0].id)}, this repository's sandbox`);
      return { sandbox: mine[0], reused: true };
    }
    const s = await createWaitingForActivation(c, {
      template: f.template ?? DEFAULT_TEMPLATE,
      ...(f.name ? { name: f.name } : {}),
      labels: { project: rid },
    });
    c.io.err(`created ${sanitizeRemote(s.id)} (${sanitizeRemote(s.template)})`);
    return { sandbox: s, reused: false };
  } catch (err) {
    return failed(c, err);
  }
}

/**
 * `mocactl sbx up` (SBX0 §6.1): in a git repository, find or create its sandbox, bind it in
 * `.sbx/sandbox.json`, and push the working tree -- unless a reused sandbox holds changes not yet
 * pulled, which are left untouched with a warning.
 *
 * The agent configuration (spec §6.3, agent-config.ts) is checked before anything is created and
 * written after the push, unless `--no-agent-config`.
 */
export async function cmdUp(
  c: SbxCtx,
  root: string,
  f: UpFlags,
  factory?: ExecFactory,
  agentop: AgentopExec = runAgentop,
): Promise<number> {
  const p = await plan(c, root, f);
  if (typeof p === 'number') return p;
  try {
    bindingUrl(c.url); // refused now, not after a sandbox was created for nothing
  } catch (err) {
    if (!(err instanceof PushError)) throw err;
    say(c, err.message);
    return SBX_EXIT.failed;
  }
  // Cortex mode is a choice made once (the flag) and kept (the record): a later plain `up` keeps it.
  const cortex = !f.noAgentConfig && (f.cortex === true || cortexMode(root));
  // The agent configuration is checked now, so a conflict stops `up` with nothing created,
  // bound or pushed; it is written after the push, so the push carries the developer's tree.
  if (!f.noAgentConfig) {
    try {
      writeAgentConfig(root, { dryRun: true, cortex });
    } catch (err) {
      if (!(err instanceof ConfigConflict)) throw err;
      say(c, err.message);
      return SBX_EXIT.failed;
    }
  }
  // Then Cortex is checked and its script installed, still with nothing created, bound or pushed: a
  // repository in Cortex mode without the script would have nothing keeping the agent off local tools.
  // After the dry run, because the install changes the shared Cortex (~/.cortex): a conflict must not.
  if (cortex) {
    const bad = await agentopProblem(agentop);
    if (bad) {
      say(c, `sbx up --cortex: ${bad}; install it with: ${CORTEX_INSTALL}`);
      return SBX_EXIT.failed;
    }
    const got = await installMocaSandbox(agentop);
    if (!got.ok) {
      say(c, `Cortex could not install ${MOCA_SANDBOX}: ${got.message}`);
      return SBX_EXIT.failed;
    }
    if (got.message) c.io.err(got.message);
  }
  const rid = await repoId(root);
  const found = await findOrCreate(c, rid, f);
  if (typeof found === 'number') return found;
  const { sandbox: s, reused } = found;
  try {
    writeBinding(root, { id: s.id, controlPlaneUrl: c.url, template: s.template });
  } catch (err) {
    if (!(err instanceof PushError)) throw err;
    say(c, err.message);
    return SBX_EXIT.failed;
  }
  const code = await withExec(c, s.id, factory, async (x) => {
    try {
      // A reused sandbox is checked in the Exec that empties it; a new one has nothing to lose.
      await doPush(c, x, s.id, p, reused);
    } catch (err) {
      if (!(err instanceof UnpulledError)) throw err;
      say(
        c,
        `${UNPULLED_TEXT}, so it was left as it is (not pushed): run mocactl sbx pull --apply, ` +
          'or mocactl sbx push --force to discard them',
      );
    }
    return SBX_EXIT.ok;
  });
  if (code !== SBX_EXIT.ok) return code;
  if (!f.noAgentConfig) {
    try {
      const { changed } = writeAgentConfig(root, { cortex, mode: s.mode });
      if (cortex) c.io.err(CORTEX_NOTE);
      if (changed.length) {
        c.io.err(`configured Claude Code, OpenCode and IBM Bob: ${changed.join(', ')}`);
        // enabledMcpjsonServers does not suppress the prompt on a first session (#577), and its
        // highlighted default declines, which leaves the agent with no tools at all. Say so here:
        // by the time it appears, this output is the only place the recovery was ever named.
        c.io.err(
          `start claude in ${root} (not a subdirectory); the first session asks about the ` +
            `sandbox MCP server, and the highlighted default declines — choose ` +
            `"${CLAUDE_PROMPT_PICK}", or start it with mocactl sbx claude, which registers the ` +
            `server for that run and asks nothing about it — Claude Code may still ask once ` +
            `whether you trust the folder (mocactl sbx doctor tells you how to undo a decline)`,
        );
      }
    } catch (err) {
      say(
        c,
        `sandbox ${s.id} is up and bound, but the agent configuration was not written: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return SBX_EXIT.failed;
    }
  }
  c.io.out(`${s.id}\n`);
  c.io.err(
    `sandbox ${s.id} (${sanitizeRemote(s.template)}), expires ${when(s.expiresAt)}; bound in .sbx/sandbox.json`,
  );
  return SBX_EXIT.ok;
}

/**
 * Before `sbx rm` deletes a sandbox (final review I3): undefined when it holds nothing a delete
 * would lose, else the exit code after saying why it was not deleted. Work not yet pulled refuses;
 * so does a check that cannot run (a worker that is down runs no Exec), since silence is not
 * "clean". A terminated sandbox (deleted or expired) or a purged one mints no token ever again, so
 * no command can reach its workspace: nothing a delete could lose. `--force` skips this. A login or network
 * failure keeps its own exit (3 or 4): the delete could not have been made either.
 */
export async function checkBeforeRm(
  c: SbxCtx,
  id: string,
  bound: boolean,
  factory?: ExecFactory,
): Promise<number | undefined> {
  const force = `mocactl sbx rm --force${bound ? '' : ` ${id}`}`;
  const cannot = (why: string) => {
    say(
      c,
      `cannot check ${id} for changes not yet pulled: ${why}; nothing was deleted. Pull them ` +
        `first if you can, or delete it anyway with ${force}`,
    );
    return SBX_EXIT.failed;
  };
  let x: OpenedExec;
  try {
    x = await openExec(c.api, id, factory);
  } catch (err) {
    if (c.signal?.aborted) return 130;
    if (err instanceof ApiError) {
      if (err.status === 0 || err.code === 'not_enrolled' || TOKEN_CODES.has(err.code)) {
        return failed(c, err);
      }
      // Terminated (deleted or expired) or purged: no token is ever minted for it again, so no
      // command can reach its workspace, and a delete loses nothing it could have pulled.
      if (err.code === 'sandbox_terminated' || err.code === 'sandbox_not_found') return undefined;
      return cannot(describeError(err));
    }
    return cannot(sandboxFailureText(err));
  }
  try {
    if (!(await hasUnpulled(x.exec, undefined, { signal: c.signal }))) return undefined;
  } catch (err) {
    if (c.signal?.aborted) return 130;
    return cannot(err instanceof PushError ? err.message : sandboxFailureText(err));
  } finally {
    x.close();
  }
  const pull = bound ? 'mocactl sbx pull --apply' : `mocactl sbx pull --sandbox ${id} --apply`;
  say(
    c,
    `${UNPULLED_TEXT}, so ${id} was not deleted: run ${pull} to keep them, or ${force} to ` +
      'delete it with them',
  );
  return SBX_EXIT.failed;
}

/**
 * After `sbx rm` of the bound sandbox: take back the agent configuration `up` added, then `.sbx/`.
 * A file it can no longer read stops it with nothing removed (the record stays in `.sbx/`, so a
 * second `rm` finishes the job once the file is fixed).
 */
export function unbind(c: SbxCtx, root: string): number {
  let removed: string[];
  let kept: boolean;
  try {
    const r = takeBackAgentConfig(root);
    for (const w of r.warnings) say(c, w);
    removed = r.removed;
    kept = r.recordKept;
  } catch (err) {
    // A ConfigConflict names its file; anything else (a file system error) names its path, if any.
    const e = err as NodeJS.ErrnoException;
    say(
      c,
      err instanceof ConfigConflict
        ? err.message
        : `could not take back the agent configuration${e.path ? ` in ${e.path}` : ''}: ` +
            `${e.code ? `${e.code} ` : ''}${e.message ?? String(err)}; ` +
            'its record is kept in .sbx/agent-config.json, so mocactl sbx rm can be run again',
    );
    return SBX_EXIT.failed;
  }
  if (removed.length) {
    c.io.err(`removed the agent configuration sbx up added: ${removed.join(', ')}`);
  }
  if (kept) {
    // The sandbox is deleted; only the record is in doubt, so this is not a failure of rm.
    c.io.err('kept .sbx/, for its agent-config.json');
    return SBX_EXIT.ok;
  }
  rmSync(join(root, '.sbx'), { recursive: true, force: true });
  c.io.err('removed .sbx/ (the binding)');
  return SBX_EXIT.ok;
}
