import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Builds dist/mocactl.mjs the way the release workflow does, then runs it from a temp dir with no
// node_modules in reach: a dependency left unbundled, or one that needs `require` (Ink's
// signal-exit), fails here rather than on a user's machine. Spec §4 and §7.
const pkg = fileURLToPath(new URL('..', import.meta.url));
const VERSION = 'v9.9.9-bundle-test';
// Measured 2026-10-19 at 6 916 540 bytes (SBX0 1c, Task 9); about 11 % headroom, in whole 100 kB.
const BUNDLE_BUDGET_BYTES = 7_700_000;
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

  // SBX0 §6.4: mocactl ships as one file, and @moca/sandbox-client (grpc-js, protobuf, the MCP SDK)
  // went into it. The budget makes growth a decision: raise BUNDLE_BUDGET_BYTES deliberately, in
  // the change that needs it, with the new measured size. The size is printed so a reviewer sees it
  // move. CI runs this in the `check` job (`pnpm -r test`).
  it('stays within its size budget', () => {
    const size = statSync(bundle).size;
    console.log(
      `mocactl bundle: ${size} bytes (${(size / 2 ** 20).toFixed(2)} MiB), ` +
        `budget ${BUNDLE_BUDGET_BYTES} bytes`,
    );
    expect(Number.isSafeInteger(BUNDLE_BUDGET_BYTES)).toBe(true);
    expect(size).toBeLessThanOrEqual(BUNDLE_BUDGET_BYTES);
  });

  // ADR-0036/0042: Pi stays out of mocactl. sandbox-client's contract test links Pi as a dev
  // dependency; nothing of it may be bundled.
  it('bundles nothing of Pi', () => {
    const text = readFileSync(bundle, 'utf8');
    for (const pi of ['@earendil-works', 'pi-coding-agent', 'pi-agent-core']) {
      expect(text.includes(pi), pi).toBe(false);
    }
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
        "while time.time() < end and b'Log in' not in out:",
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
      expect(r.stdout).toContain('Log in');
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

  // `sbx mcp` loads the MCP SDK's stdio transport lazily: a bundling gap would show only here. The
  // control plane is an in-process fake; the client closes stdin, and the server must then exit.
  it('serves MCP on stdio as `sbx mcp`, with nothing but frames on stdout', async () => {
    const SBX = 'sbx-0123456789abcdef0123456789';
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url !== `/v1/sandboxes/${SBX}`) {
        res.statusCode = 404;
        return res.end('{"error":"not_found"}');
      }
      res.end(
        JSON.stringify({
          id: SBX,
          owner: 'github:1',
          name: null,
          template: 'node22',
          state: 'ready',
          reason: null,
          createdAt: 1,
          expiresAt: 4_000_000_000,
          terminatedAt: null,
          labels: {},
        }),
      );
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
      const config = join(dir, 'mcp-config');
      mkdirSync(join(config, 'mocactl'), { recursive: true });
      writeFileSync(
        join(config, 'mocactl', 'sbx-auth.json'),
        JSON.stringify({
          apiToken: 'api-1',
          subject: 'github:1',
          roles: [],
          expiresAt: 4_000_000_000,
          controlPlaneUrl: url,
        }),
      );
      const p = spawn(process.execPath, [bundle, 'sbx', 'mcp', '--sandbox', SBX], {
        cwd: dir,
        env: cleanEnv({
          XDG_CONFIG_HOME: config,
          XDG_STATE_HOME: join(dir, 'mcp-state'),
          MOCACTL_SBX_URL: url,
        }),
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const frames = () => out.split('\n').filter((l) => l.trim());
      const send = (m: object) => p.stdin.write(JSON.stringify(m) + '\n');
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'sandbox_info', arguments: {} },
      });
      const deadline = Date.now() + 10_000;
      while (frames().length < 2 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      p.stdin.end();
      const code = await new Promise((r) => p.on('exit', r));
      expect(code, err).toBe(0);
      const parsed = frames().map(
        (l) =>
          JSON.parse(l) as {
            jsonrpc: string;
            id?: number;
            result?: { content: { text: string }[] };
          },
      );
      expect(parsed.every((f) => f.jsonrpc === '2.0')).toBe(true);
      expect(parsed.find((f) => f.id === 2)?.result?.content[0]?.text).toMatch(/template node22/);
    } finally {
      srv.close();
    }
  }, 20_000);

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
