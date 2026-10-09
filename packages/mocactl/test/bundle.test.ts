import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Builds dist/mocactl.mjs the way the release workflow does, then runs it from a temp dir with no
// node_modules in reach: a dependency left unbundled, or one that needs `require` (Ink's
// signal-exit), fails here rather than on a user's machine. Spec §4 and §7.
const pkg = fileURLToPath(new URL('..', import.meta.url));
const VERSION = 'v9.9.9-bundle-test';
let dir: string;
let bundle: string;

// Everything but NODE_PATH, which could resolve a dependency the bundle forgot.
const cleanEnv = (extra: Record<string, string> = {}) => {
  const { NODE_PATH: _drop, ...rest } = process.env;
  return { ...rest, ...extra };
};

const build = (args: string[]) => {
  const r = spawnSync(process.execPath, ['build.mjs', ...args], {
    cwd: pkg,
    env: cleanEnv({ MOCACTL_VERSION: VERSION }),
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
};

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [bundle, ...args], {
    cwd: dir,
    env: cleanEnv(env),
    encoding: 'utf8',
  });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mocactl-bundle-'));
  bundle = join(dir, 'mocactl.mjs');
  build(['--outfile', bundle]);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the bundle', () => {
  it('prints the version it was built with', () => {
    const r = run(['--version']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${VERSION}\n`);
  });

  it('starts with a node shebang, so the installer can run it as `mocactl`', () => {
    expect(readFileSync(bundle, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
  });

  it('runs a headless command with no node_modules in reach', () => {
    const r = run(['--help']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('usage:');
  });

  // Ink needs a terminal, so the TUI is run under a pseudo-terminal from python3's pty module, which
  // is on every GitHub runner and macOS. The control plane URL points at a closed port: the login
  // screen rendering (and then reporting it unreachable) proves Ink, React and yoga all loaded.
  const python = spawnSync('python3', ['--version']).status === 0;
  it.skipIf(!python)(
    'renders the interactive UI under a pseudo-terminal',
    () => {
      const script = [
        'import os, pty, re, select, signal, sys, time',
        'pid, fd = pty.fork()',
        'if pid == 0:',
        '    os.execv(sys.argv[1], sys.argv[1:])',
        "out = b''",
        'end = time.time() + 8',
        "while time.time() < end and b'Log in with GitHub' not in out:",
        '    r, _, _ = select.select([fd], [], [], 0.2)',
        '    if r:',
        '        try: out += os.read(fd, 65536)',
        '        except OSError: break',
        'os.kill(pid, signal.SIGKILL)',
        "sys.stdout.write(re.sub(rb'\\x1b\\[[0-9;?]*[a-zA-Z]', b'', out).decode(errors='replace'))",
      ].join('\n');
      const r = spawnSync('python3', ['-c', script, process.execPath, bundle, '--no-animation'], {
        cwd: dir,
        env: cleanEnv({
          SH_CONTROL_PLANE_URL: 'http://127.0.0.1:9',
          XDG_CONFIG_HOME: join(dir, 'config'),
          TERM: 'xterm-256color',
          // Ink renders non-interactively under CI (is-in-ci: CI or CONTINUOUS_INTEGRATION, unless
          // '0' or 'false') and writes no frame until unmount; this child is killed first, so it must
          // not look like CI. GitHub Actions sets CI=true.
          CI: 'false',
          CONTINUOUS_INTEGRATION: 'false',
        }),
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(r.stdout).not.toContain('Dynamic require');
      expect(r.stdout).toContain('Log in with GitHub');
    },
    20_000,
  );

  // The layout scripts/install-mocactl.sh leaves: mocactl.mjs, and `mocactl` a relative symlink to it,
  // under a "type": "commonjs" package.json like the one `npm init -y` writes in a home directory.
  // Node takes the module type from the main script's real path, so the symlink runs as ESM; an
  // extensionless copy loads as CommonJS and prints nothing at all (the control case).
  it('runs as `mocactl` through the installed symlink, even under a commonjs package.json', () => {
    const home = join(dir, 'home');
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(home, 'package.json'), '{"type":"commonjs"}\n');
    copyFileSync(bundle, join(bin, 'mocactl.mjs'));
    symlinkSync('mocactl.mjs', join(bin, 'mocactl'));
    copyFileSync(bundle, join(bin, 'mocactl-copy'));

    const viaLink = spawnSync(process.execPath, [join(bin, 'mocactl'), '--version'], {
      cwd: home,
      env: cleanEnv(),
      encoding: 'utf8',
    });
    expect(viaLink.status, viaLink.stderr).toBe(0);
    expect(viaLink.stdout).toBe(`${VERSION}\n`);

    const viaCopy = spawnSync(process.execPath, [join(bin, 'mocactl-copy'), '--version'], {
      cwd: home,
      env: cleanEnv(),
      encoding: 'utf8',
    });
    expect(viaCopy.stdout).not.toBe(`${VERSION}\n`);
  });

  it('turns a missing clipboard tool into a rejected copy, not a crash', () => {
    const probe = join(dir, 'clipboard-probe.mjs');
    build(['--entry', 'test/fixtures/clipboard-probe.ts', '--outfile', probe]);
    const r = spawnSync(process.execPath, [probe], {
      cwd: dir,
      env: cleanEnv({ PATH: join(dir, 'no-such-dir') }),
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^rejected: /);
    // A full esbuild run: a cold start on a shared runner can approach vitest's 5 s default.
  }, 30_000);
});
