import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../src/worker.ts', import.meta.url)), 'utf8');
const serverSrc = readFileSync(fileURLToPath(new URL('../src/server.ts', import.meta.url)), 'utf8');
const workerPath = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

// Anchored to start-of-line: worker.ts also names this call inside a `//` comment, which an
// unanchored match would accept with the real call deleted (PR #350 review).
const BOOT_CALL = /^\s*prepareServerProcess\(process\.env\);/m;

/**
 * Fork the worker with an IPC channel, as the supervisor forks it: without one it exits on the
 * missing channel before it reaches the boot checks. Resolves on exit, or -- for a worker that
 * passes them -- on its `ready` message, after which it is killed.
 *
 * `node --import tsx`, as the supervisor runs it, not the `tsx` CLI: the CLI is a wrapper process,
 * so killing it after `ready` orphaned the real worker, which held the stderr pipe open and left
 * 'close' to the test timeout.
 */
async function bootWorker(
  env: Record<string, string>,
): Promise<{ status: number | null; stderr: string; ready: boolean }> {
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath], {
    cwd: PKG_DIR,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  let stderr = '';
  let ready = false;
  child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
  child.on('message', (msg: { type?: string }) => {
    if (msg?.type === 'ready') {
      ready = true;
      child.kill('SIGKILL');
    }
  });
  // 'close', not 'exit': only 'close' guarantees the piped stderr has been drained. An 'error'
  // (tsx missing, spawn refused) rejects instead of waiting out the timer.
  const status = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  return { status, stderr, ready };
}

describe('every server entry point runs the same boot function (MI1 R2)', () => {
  it('the P6 worker calls prepareServerProcess at boot', () => {
    expect(src).toMatch(BOOT_CALL);
  });
  it('startServer calls prepareServerProcess', () => {
    expect(serverSrc).toMatch(BOOT_CALL);
  });
  it('the P6 worker refuses to boot under MOCA_TENANCY=multi without SH_REQUIRE_AUTH', async () => {
    // The behaviour, not the source text.
    const r = await bootWorker({ MOCA_TENANCY: 'multi' });
    expect(r.stderr).toMatch(/MOCA_TENANCY=multi requires SH_REQUIRE_AUTH=true/);
    expect(r.status).toBe(2);
    expect(r.ready).toBe(false);
  }, 30_000);
  it('no entry point calls assertKeysetUsable directly any more', () => {
    expect(src).not.toMatch(/^\s*assertKeysetUsable\(/m);
    expect(serverSrc).not.toMatch(/^\s*assertKeysetUsable\(/m);
  });
});

describe('the P6 worker validates the sandbox tiers at boot (P6.3 spec §3.4)', () => {
  // The selection reads the knobs per call, so without a boot check a typo passes /health and
  // fails the first turn -- the shape the SH_SANDBOX_DISCOVERY check closed.
  it('exits 2 before ready on a duplicate tier, naming SH_SANDBOX_TIERS', async () => {
    const r = await bootWorker({ SH_SANDBOX_TIERS: 'container,container' });
    expect(r.stderr).toMatch(/SH_SANDBOX_TIERS names 'container' twice/);
    expect(r.status).toBe(2);
    expect(r.ready).toBe(false);
  }, 30_000);
  it('exits 2 before ready on a default outside the list, naming SH_SANDBOX_DEFAULT_TIER', async () => {
    const r = await bootWorker({
      SH_SANDBOX_TIERS: 'container,microvm',
      SH_SANDBOX_DEFAULT_TIER: 'gpu',
    });
    expect(r.stderr).toMatch(/SH_SANDBOX_DEFAULT_TIER='gpu'/);
    expect(r.status).toBe(2);
    expect(r.ready).toBe(false);
  }, 30_000);
  it('boots to ready on a valid pair', async () => {
    const r = await bootWorker({
      SH_SANDBOX_TIERS: 'container,microvm',
      SH_SANDBOX_DEFAULT_TIER: 'container',
    });
    expect(r.stderr).toBe('');
    expect(r.ready).toBe(true);
  }, 30_000);
});
