import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecMachineryError,
  leaseNotice,
  type Exec,
  type ExecConnOptions,
  type ExecResult,
} from '@moca/sandbox-client';
import { afterEach, describe, expect, it } from 'vitest';
import { saveAuth } from '../src/config.js';
import { checkAgentConfig, writeAgentConfig } from '../src/sbx/agent-config.js';
import { openSbxRuntime, sbxMain, sbxPaths } from '../src/sbx/cli.js';
import type { SbxCtx } from '../src/sbx/commands.js';
import {
  installedClaudeVersion,
  percentile,
  runDoctor,
  type DoctorCheck,
} from '../src/sbx/doctor.js';
import type { ExecFactory } from '../src/sbx/exec.js';
import { recordCall } from '../src/sbx/recorder.js';
import {
  LOGIN,
  NO_LEASE,
  SBX,
  URL_,
  cleanupTmp,
  controlPlane,
  leaseEnd,
  repo,
  sandbox,
  setup,
  withLeaseEvents,
} from './helpers/sbx.js';

afterEach(cleanupTmp);

const nowS = () => Math.floor(Date.now() / 1000);
const res = (o: Partial<ExecResult> = {}): ExecResult => ({
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  exitCode: 0,
  truncated: false,
  lease: [],
  ...o,
});

/**
 * A scripted sandbox: `true` answers `exitCode`, the state check answers `state` (as push.ts's
 * STATE script prints it), and `fail` makes every Exec throw.
 */
function fakeExec(o: { state?: string; fail?: Error; exitCode?: number } = {}) {
  const sent: string[] = [];
  const opts: { timeoutS?: number }[] = [];
  const conns: ExecConnOptions[] = [];
  let closed = 0;
  const exec: Exec = async (command, x = {}) => {
    sent.push(command);
    opts.push({ ...(x.timeoutS !== undefined ? { timeoutS: x.timeoutS } : {}) });
    if (o.fail) throw o.fail;
    if (command === 'true') return res({ exitCode: o.exitCode ?? 0 });
    return res({ stdout: Buffer.from(`${o.state ?? 'clean'}\n`) });
  };
  const factory: ExecFactory = (c) => {
    conns.push(c);
    return { exec, close: () => void closed++, ...NO_LEASE };
  };
  return { factory, sent, opts, conns, closed: () => closed };
}

function world(
  o: { expiresInS?: number; state?: string; loggedIn?: boolean; box?: object | null } = {},
) {
  const s = setup({ loggedIn: o.loggedIn !== false });
  const box =
    o.box === null
      ? []
      : [sandbox({ id: SBX, expiresAt: nowS() + (o.expiresInS ?? 3 * 86_400), ...o.box })];
  const cp = controlPlane(box);
  const r = repo();
  writeAgentConfig(r);
  const ctx = (): SbxCtx => ({
    ...openSbxRuntime(URL_, s.env, { home: s.home, fetchImpl: cp.fetchImpl }),
    url: URL_,
    io: s.io,
    json: false,
  });
  return { ...s, cp, r, ctx };
}

/** A `claude --version` the deny list covers: doctor never asks the real one in a test. */
const CURRENT = () => '2.1.304 (Claude Code)';

const byName = (cs: DoctorCheck[], name: string) => {
  const c = cs.find((k) => k.name === name);
  if (!c) throw new Error(`no ${name} check in ${cs.map((k) => k.name).join(', ')}`);
  return c;
};

describe('mocactl sbx doctor (SBX0 §6.1)', () => {
  it('passes all six checks for a configured repository and a sandbox with days left', async () => {
    const w = world();
    const x = fakeExec();
    const cs = await runDoctor(w.ctx(), w.r, SBX, x.factory, CURRENT);
    expect(cs.map((k) => k.name)).toEqual([
      'login',
      'sandbox',
      'agent config',
      'exec',
      'changes',
      'recent calls',
    ]);
    for (const k of cs) expect(k.ok, `${k.name}: ${k.detail}`).toBe(true);
    expect(byName(cs, 'login').detail).toContain('github:1');
    expect(byName(cs, 'sandbox').detail).toMatch(/ready; expires \d{4}-.*in 2 d 23 h|in 3 d/);
    expect(byName(cs, 'exec').detail).toMatch(/^one `true` in a fresh VM: \d+ ms$/);
    expect(byName(cs, 'changes').detail).toBe('nothing to pull');
    expect(x.sent[0]).toBe('true');
    expect(x.closed()).toBe(1);
    // A hung relay stalls doctor for about 30 s at most per Exec: 20 s for `true` and for the
    // state check (review round 2: not push's 300 s), with a 10 s backstop margin.
    expect(x.opts).toEqual([{ timeoutS: 20 }, { timeoutS: 20 }]);
    expect(x.conns[0]!.backstopMarginS).toBe(10);
  });

  it('fails the sandbox check with less than 24 h left, naming the expiry and sbx up', async () => {
    const w = world({ expiresInS: 2 * 3600 });
    const cs = await runDoctor(w.ctx(), w.r, SBX, fakeExec().factory, CURRENT);
    const s = byName(cs, 'sandbox');
    expect(s.ok).toBe(false);
    expect(s.detail).toContain(new Date((nowS() + 7200) * 1000).toISOString().slice(0, 13));
    expect(s.detail).toMatch(/less than 24 h left/);
    expect(s.fix).toContain('mocactl sbx up');
    // A sandbox that expires soon still runs: the exec checks are made.
    expect(byName(cs, 'exec').ok).toBe(true);
  });

  it('fails for a terminated or vanished sandbox, and skips the exec', async () => {
    for (const box of [{ state: 'terminated', reason: 'expired' }, null]) {
      const w = world({ box });
      const x = fakeExec();
      const cs = await runDoctor(w.ctx(), w.r, SBX, x.factory, CURRENT);
      const s = byName(cs, 'sandbox');
      expect(s.ok).toBe(false);
      expect(s.detail).toMatch(box ? /terminated \(expired\)/ : /no longer exists/);
      expect(s.fix).toContain('mocactl sbx up');
      expect(cs.some((k) => k.name === 'exec')).toBe(false);
      expect(x.sent).toEqual([]);
    }
  });

  it('fails the agent-config check when a built-in is allowed again, naming it (spec §10.3)', async () => {
    const w = world();
    const f = join(w.r, '.claude/settings.json');
    const s = JSON.parse(readFileSync(f, 'utf8'));
    s.permissions.deny = s.permissions.deny.filter((t: string) => t !== 'Bash');
    writeFileSync(f, JSON.stringify(s));
    const cs = await runDoctor(w.ctx(), w.r, SBX, fakeExec().factory, CURRENT);
    const c = byName(cs, 'agent config');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/Bash/);
    expect(c.fix).toContain('mocactl sbx up');
  });

  it('fails a Claude Code older than the deny list covers, and is silent otherwise (#568)', async () => {
    const w = world();
    const names = (cs: DoctorCheck[]) => cs.map((k) => k.name);
    for (const v of [CURRENT, () => undefined]) {
      expect(names(await runDoctor(w.ctx(), w.r, SBX, fakeExec().factory, v))).not.toContain(
        'claude code',
      );
    }
    const cs = await runDoctor(
      w.ctx(),
      w.r,
      SBX,
      fakeExec().factory,
      () => '1.0.128 (Claude Code)',
    );
    const c = byName(cs, 'claude code');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(
      /^1\.0\.128 \(Claude Code\) is older than 2\.0\.0: its MultiEdit, LS and NotebookRead/,
    );
    expect(c.detail).toMatch(/read or edit files on this machine and are not denied$/);
    expect(c.fix).toContain('claude update');
    // Right after the agent-config check, which passes: the list itself is fine.
    expect(names(cs).indexOf('claude code')).toBe(names(cs).indexOf('agent config') + 1);
    expect(byName(cs, 'agent config').ok).toBe(true);
  });

  it("reads the installed Claude Code's version without blocking, and undefined without one (#572 review)", async () => {
    const p = installedClaudeVersion();
    expect(p).toBeInstanceOf(Promise);
    const v = await p;
    if (v !== undefined) expect(v).toMatch(/\d+\.\d+\.\d+/);
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      expect(await installedClaudeVersion()).toBeUndefined();
    } finally {
      process.env.PATH = path;
    }
  });

  it('says the denied state is checked in the project config only (review I2)', async () => {
    const w = world();
    const cs = await runDoctor(w.ctx(), w.r, SBX, fakeExec().factory, CURRENT);
    const detail = byName(cs, 'agent config').detail;
    expect(detail).toContain("in this repository's project config");
    expect(detail).toContain('user-level and managed settings are not checked');
    // Bob is in the check, and its local tools are not denied: say so rather than imply parity.
    expect(detail).toContain('IBM Bob');
    expect(detail).toContain('its own tools stay available');
  });

  it('fails the agent-config check when an OpenCode agent re-enables a tool', async () => {
    const w = world();
    const f = join(w.r, 'opencode.json');
    const o = JSON.parse(readFileSync(f, 'utf8'));
    o.agent = { build: { permission: { bash: 'allow' } } };
    writeFileSync(f, JSON.stringify(o));
    const c = byName(
      await runDoctor(w.ctx(), w.r, SBX, fakeExec().factory, CURRENT),
      'agent config',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/agent\.build\.permission\.bash/);
  });

  it("fails the agent-config check when the rules block is for another mode than the sandbox's (review #4569829055)", async () => {
    // up on a lease sandbox writes the lease rules; doctor passes them.
    const w = world({ box: { mode: 'lease', modeEpoch: 1 } });
    writeAgentConfig(w.r, { mode: 'lease' });
    const before = byName(
      await runDoctor(w.ctx(), w.r, SBX, fakeExec().factory, CURRENT),
      'agent config',
    );
    expect(before.ok, before.detail).toBe(true);
    // `sbx mode per-exec` changes the record, not the block.
    w.cp.boxes.set(SBX, { ...w.cp.boxes.get(SBX)!, mode: 'per-exec', modeEpoch: 2 });
    const after = byName(
      await runDoctor(w.ctx(), w.r, SBX, fakeExec().factory, CURRENT),
      'agent config',
    );
    expect(after.ok).toBe(false);
    expect(after.detail).toBe(
      'CLAUDE.md: has the sandbox rules block for lease mode, but the sandbox is in per-exec mode; ' +
        'AGENTS.md: has the sandbox rules block for lease mode, but the sandbox is in per-exec mode',
    );
    expect(after.fix).toContain('mocactl sbx up');
    // Without the record (no login), any mode's block is taken as up to date.
    expect(checkAgentConfig(w.r)).toEqual([]);
  });

  it('fails the agent-config check when a lease block stays after an upgrade to lease+processes (plan 5)', async () => {
    const w = world({ box: { mode: 'lease+processes', modeEpoch: 2 } });
    writeAgentConfig(w.r, { mode: 'lease' });
    const c = byName(
      await runDoctor(w.ctx(), w.r, SBX, fakeExec().factory, CURRENT),
      'agent config',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain(
      'CLAUDE.md: has the sandbox rules block for lease mode, but the sandbox is in lease+processes mode',
    );
    writeAgentConfig(w.r, { mode: 'lease+processes' });
    const ok = byName(
      await runDoctor(w.ctx(), w.r, SBX, fakeExec().factory, CURRENT),
      'agent config',
    );
    expect(ok.ok, ok.detail).toBe(true);
  });

  it('doctor says the lease events its Execs carried, on stderr (plan-4 M2)', async () => {
    const w = world();
    const end = leaseEnd({ reason: 'idle' });
    await runDoctor(w.ctx(), w.r, SBX, withLeaseEvents(fakeExec().factory, [[end]]), CURRENT);
    expect(w.io.errs).toContain(leaseNotice(end, Date.now()));
  });

  it('fails the agent-config check in a repository sbx up never configured', async () => {
    const w = world();
    const cs = await runDoctor(w.ctx(), repo(), SBX, fakeExec().factory, CURRENT);
    expect(byName(cs, 'agent config').detail).toMatch(/Claude Code[\s\S]*OpenCode/);
  });

  it('fails the exec check with the sandbox failure text when an Exec throws', async () => {
    const w = world();
    const x = fakeExec({ fail: new ExecMachineryError('sandbox failure: worker unavailable') });
    const cs = await runDoctor(w.ctx(), w.r, SBX, x.factory, CURRENT);
    const e = byName(cs, 'exec');
    expect(e.ok).toBe(false);
    expect(e.detail).toContain('worker unavailable');
    expect(e.fix).toBeDefined();
    expect(cs.some((k) => k.name === 'changes')).toBe(false);
    expect(x.closed()).toBe(1);
  });

  it('finishes within its bound when the state check hangs', async () => {
    const w = world();
    // A sandbox that answers `true`, then hangs until the Exec's own timeout, as the worker would
    // end it (the fake answers at once with what the worker says at timeoutS).
    const asked: number[] = [];
    const exec: Exec = async (command, o = {}) => {
      if (command === 'true') return res();
      asked.push(o.timeoutS ?? -1);
      return res({ exitCode: -1, timedOutS: o.timeoutS ?? 300 });
    };
    const t0 = Date.now();
    const cs = await runDoctor(
      w.ctx(),
      w.r,
      SBX,
      () => ({ exec, close: () => {}, ...NO_LEASE }),
      CURRENT,
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(asked).toEqual([20]);
    const c = byName(cs, 'changes');
    expect(c.ok).toBe(false);
    expect(c.detail).toBe('checking for changes failed in the sandbox: timed out after 20s');
    expect(c.fix).toBeDefined();
  });

  it('fails the exec check when `true` itself fails', async () => {
    const w = world();
    const cs = await runDoctor(w.ctx(), w.r, SBX, fakeExec({ exitCode: 127 }).factory, CURRENT);
    expect(byName(cs, 'exec')).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/exited 127/),
    });
  });

  it('warns, without failing, when the sandbox has changes not yet pulled', async () => {
    for (const state of ['dirty', 'no_baseline']) {
      const w = world();
      const cs = await runDoctor(w.ctx(), w.r, SBX, fakeExec({ state }).factory, CURRENT);
      const c = byName(cs, 'changes');
      expect(c.ok).toBe(true);
      expect(c.warn).toBe(true);
      expect(c.detail).toContain('changes not yet pulled');
      expect(cs.every((k) => k.ok)).toBe(true);
    }
  });

  it("summarizes the flight recorder's last 24 h: calls, p50/p95 and errors", async () => {
    const w = world();
    const ts = (ago: number) => new Date(Date.now() - ago).toISOString();
    recordCall(w.paths.stateDir, SBX, { ts: ts(1000), tool: 'bash', ms: 100, execs: 1, ok: true });
    recordCall(w.paths.stateDir, SBX, { ts: ts(2000), tool: 'read', ms: 300, execs: 1, ok: true });
    recordCall(w.paths.stateDir, SBX, {
      ts: ts(3000),
      tool: 'bash',
      ms: 200,
      execs: 1,
      ok: false,
      error: 'sandbox busy',
    });
    // Older than a day: not counted.
    recordCall(w.paths.stateDir, SBX, {
      ts: ts(2 * 86_400_000),
      tool: 'bash',
      ms: 9999,
      execs: 1,
      ok: false,
    });
    const cs = await runDoctor(w.ctx(), w.r, SBX, fakeExec().factory, CURRENT);
    const c = byName(cs, 'recent calls');
    expect(c.ok).toBe(true);
    expect(c.detail).toBe(
      "3 calls in the last 24 h: p50 200 ms, p95 300 ms, 1 error (1 not the command's own)",
    );
  });

  it('reports the login, and nothing that needs one, when not logged in (R7)', async () => {
    const w = world({ loggedIn: false });
    const cs = await runDoctor(w.ctx(), w.r, SBX, fakeExec().factory, CURRENT);
    expect(cs[0]).toMatchObject({ name: 'login', ok: false, fix: 'mocactl sbx login' });
    expect(cs.map((k) => k.name)).toEqual(['login', 'agent config', 'recent calls']);
    expect(w.cp.calls).toEqual([]);
  });

  it('gives a fix when the sandbox lookup fails for another reason', async () => {
    const w = world();
    w.cp.boxes.clear();
    const s = setup();
    const broken = {
      ...openSbxRuntime(URL_, s.env, {
        home: w.home,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: 'internal', message: 'boom' }), {
            status: 500,
          })) as typeof fetch,
      }),
      url: URL_,
      io: w.io,
      json: false,
    };
    const c = byName(await runDoctor(broken, w.r, SBX, fakeExec().factory, CURRENT), 'sandbox');
    expect(c.ok).toBe(false);
    expect(c.fix).toBeDefined();
  });

  it('reports an unreadable flight recorder as a failed check, and goes on', async () => {
    const w = world();
    mkdirSync(join(w.paths.stateDir, 'sbx', `${SBX}.log`), { recursive: true }); // a directory
    const cs = await runDoctor(w.ctx(), w.r, SBX, fakeExec().factory, CURRENT);
    const c = byName(cs, 'recent calls');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/cannot read the flight recorder/);
    expect(cs.map((k) => k.name)).toContain('exec');
  });

  it('outside a repository, checks everything but the agent configuration', async () => {
    const w = world();
    const cs = await runDoctor(w.ctx(), undefined, SBX, fakeExec().factory, CURRENT);
    expect(cs.map((k) => k.name)).toEqual(['login', 'sandbox', 'exec', 'changes', 'recent calls']);
    expect(cs.every((k) => k.ok)).toBe(true);
  });

  it('has a nearest-rank percentile', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([4, 1, 3, 2], 95)).toBe(4);
  });
});

describe('mocactl sbx doctor, the command', () => {
  function cli(o: Parameters<typeof world>[0] = {}) {
    const w = world(o);
    mkBinding(w.r);
    const run = (argv: string[], x = fakeExec(), env: Record<string, string> = w.env) => {
      w.io.outs.length = 0;
      w.io.errs.length = 0;
      return sbxMain(argv, env, w.io, {
        home: w.home,
        fetchImpl: w.cp.fetchImpl,
        cwd: join(w.r, 'src'),
        execFactory: x.factory,
        claudeVersion: CURRENT,
      });
    };
    return { ...w, run, out: () => w.io.outs.join('') };
  }
  const mkBinding = (r: string) =>
    writeFileSync(
      join(r, '.sbx/sandbox.json'),
      JSON.stringify({ id: SBX, controlPlaneUrl: URL_, template: 'node22' }),
    );

  it('prints one line per check and exits 0 when all pass', async () => {
    const h = cli();
    expect(await h.run(['doctor'])).toBe(0);
    const lines = h.out().trimEnd().split('\n');
    expect(lines).toHaveLength(6);
    for (const l of lines) expect(l).toMatch(/^ok - /);
    expect(lines[3]).toMatch(/^ok - exec: one `true` in a fresh VM: \d+ ms$/);
  });

  it('exits 1 with FAIL and the fix when a check fails; a warning alone exits 0', async () => {
    const h = cli();
    const f = join(h.r, 'opencode.json');
    const o = JSON.parse(readFileSync(f, 'utf8'));
    o.tools.bash = true;
    writeFileSync(f, JSON.stringify(o));
    expect(await h.run(['doctor'])).toBe(1);
    expect(h.out()).toMatch(/^FAIL - agent config: .*OpenCode.*bash.*\(fix: mocactl sbx up/m);
    const g = cli();
    expect(await g.run(['doctor'], fakeExec({ state: 'dirty' }))).toBe(0);
    expect(g.out()).toMatch(/^warn - changes: changes not yet pulled/m);
  });

  it('runs its own login check instead of exiting 3 first (R7)', async () => {
    const h = cli({ loggedIn: false });
    expect(await h.run(['doctor'])).toBe(1);
    // MOCACTL_SBX_URL names the control plane, so the fix names it too.
    expect(h.out()).toMatch(
      /^FAIL - login: not logged in to https:\/\/sbx-api\.example\.invalid \(fix: mocactl sbx login --control-plane-url 'https:\/\/sbx-api\.example\.invalid'\)$/m,
    );
    expect(h.io.errs.join('')).not.toMatch(/not logged in/);
  });

  it('prints JSON with --json', async () => {
    const h = cli();
    expect(await h.run(['doctor', '--json'])).toBe(0);
    const j = JSON.parse(h.out());
    expect(j.ok).toBe(true);
    expect(j.checks).toHaveLength(6);
    expect(j.checks[0]).toMatchObject({ name: 'login', ok: true });
  });

  it("uses the binding's control plane, and --sandbox", async () => {
    const h = cli();
    // No MOCACTL_SBX_URL: the bound sandbox's control plane (R5j).
    expect(await h.run(['doctor'], fakeExec(), { HOME: h.home })).toBe(0);
    expect(await h.run(['doctor', '--sandbox', SBX])).toBe(0);
    expect(await h.run(['doctor', '--sandbox', '../x'])).toBe(2);
  });

  it('runs outside a git repository with --sandbox, skipping only the agent configuration', async () => {
    const h = cli();
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-norepo-')));
    try {
      const code = await sbxMain(['doctor', '--sandbox', SBX], h.env, h.io, {
        home: h.home,
        fetchImpl: h.cp.fetchImpl,
        cwd: plain,
        execFactory: fakeExec().factory,
      });
      expect(code).toBe(0);
      expect(h.out()).toMatch(/^ok - sandbox: /m);
      expect(h.out()).not.toMatch(/agent config/);
      expect(h.io.errs.join('')).toMatch(
        /not in a git repository: the agent configuration is not checked/,
      );
      // Without --sandbox, nothing to check against: a usage error, as before.
      h.io.outs.length = 0;
      const none = await sbxMain(['doctor'], h.env, h.io, {
        home: h.home,
        fetchImpl: h.cp.fetchImpl,
        cwd: plain,
      });
      expect(none).toBe(2);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('fails the sandbox check, not the command line, when nothing is bound', async () => {
    const h = cli();
    writeFileSync(join(h.r, '.sbx/sandbox.json'), '{}');
    expect(await h.run(['doctor'])).toBe(1);
    expect(h.out()).toMatch(/^FAIL - sandbox: no sandbox is bound here/m);
  });

  it('refuses arguments and flags that are not its own', async () => {
    const h = cli();
    for (const argv of [
      ['doctor', SBX],
      ['doctor', '--force'],
      ['doctor', '--keep-config'],
    ]) {
      expect(await h.run(argv), argv.join(' ')).toBe(2);
    }
  });

  it('reports a login the control plane no longer takes', async () => {
    const h = cli();
    saveAuth(sbxPaths(h.paths), { ...LOGIN, expiresAt: 1_000, refreshToken: undefined });
    expect(await h.run(['doctor'])).toBe(1);
    expect(h.out()).toMatch(/^FAIL - login: /m);
  });
});
