import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configCacheDir,
  configRefsDir,
  leafConfigDir,
  buildCacheAcquireScript,
  buildCachePopulateScript,
  buildLeafBindScript,
  buildConfigCleanupScript,
  overlayConfig,
} from '../src/config-overlay.js';

const DIGEST = 'sha256:' + 'a'.repeat(64);
const CACHE = `/workspace/.sh-config/sha256-${'a'.repeat(64)}`;
const REFS = `/workspace/.sh-config/.refs/sha256-${'a'.repeat(64)}`;

describe('paths', () => {
  it('caches by digest, shared across leaves', () => {
    expect(configCacheDir(DIGEST)).toBe(CACHE);
  });
  it('binds per leaf under the leaf workspace, torn down by run-leaf.ts on the prompt-leaf path (buildConfigCleanupScript) or by cleanupWorkspace when the leaf converges', () => {
    expect(leafConfigDir('leaf-1')).toBe('/workspace/leaves/leaf-1/.sh-config');
  });
  it('keeps the refcount tree beside the digest dirs, dot-prefixed so a `sha256-*` glob skips it', () => {
    // The docs enumerate cached
    // bundles through a `/workspace/.sh-config/sha256-*` glob. A refs tree matching that glob
    // would be counted as a cached bundle and make the demo's emptiness assertion fail with the
    // cache genuinely empty, so the dot prefix is load-bearing, not cosmetic. It does NOT hide
    // refs from an unscoped `find /workspace/.sh-config`, which is why the walkthrough scopes its
    // listing too.
    expect(configRefsDir(DIGEST)).toBe(`/workspace/.sh-config/.refs/sha256-${'a'.repeat(64)}`);
    expect(configRefsDir(DIGEST).startsWith('/workspace/.sh-config/.')).toBe(true);
  });
  it('rejects an invalid digest rather than composing a path from it', () => {
    expect(() => configRefsDir("x'; rm -rf /; '")).toThrow(/invalid digest/i);
  });
});

// Acquire, not probe: issue #216. The old probe was a pure read, and a cache that nothing ever
// released outlived the leaf that created it -- so a later leaf dispatched with NO configRef could
// lease the same pooled sandbox, find a sibling's promoted CLAUDE.md and memory/ on disk, and answer
// from them. That breaks spec §2 goal 6 ("absent a promoted bundle, harness behavior is unchanged")
// observably, because tools run in the sandbox. Registering a ref here is what lets cleanup know
// when the last leaf using a digest is gone.
describe('buildCacheAcquireScript', () => {
  const s = buildCacheAcquireScript(DIGEST, 'leaf-1');

  it('prints hit or miss so overlayConfig can skip the transfer on a warm cache', () => {
    expect(s).toContain(`printf 'hit'`);
    expect(s).toContain(`printf 'miss'`);
  });

  it('registers this leaf under the digest so the cache is refcounted', () => {
    expect(s).toContain(`REFS='${REFS}'`);
    expect(s).toContain(': > "$REFS/leaf-1"');
  });

  it('rejects a sessionId that could escape the refs dir or aim the teardown’s rm', () => {
    for (const bad of ['../../etc', 'a/b', '.', '..', '', 'a b', 'a;rm -rf /'])
      expect(() => buildCacheAcquireScript(DIGEST, bad)).toThrow(/invalid sessionId/i);
  });

  it('registers the ref and reads the cache under ONE flock, matching converge.ts discipline', () => {
    expect(s).toMatch(/flock 9[\s\S]*REFS[\s\S]*-d "\$DIR"[\s\S]*9>"\$LOCK"/);
    expect(s).toContain('LOCK=/workspace/.sh-config.lock');
  });

  it('registers the ref BEFORE checking whether the cache exists', () => {
    // The ordering is the whole race fix, so it is asserted rather than trusted. If the presence
    // check came first, a leaf could read `hit`, then a concurrent leaf's cleanup could observe an
    // empty refs dir and delete the cache -- leaving this leaf's symlink dangling and its turn
    // running with silently-absent configuration. That is precisely the plausible-but-wrong-work
    // failure the promotion design exists to prevent (spec §4.4).
    expect(s.indexOf('"$REFS/')).toBeLessThan(s.indexOf('-d "$DIR"'));
  });

  it('creates the refs dir inside the lock, not before it', () => {
    // A concurrent cleanup rmdir's the empty refs dir under the same lock. Doing `mkdir -p` outside
    // the lock leaves a window where that rmdir lands between our mkdir and our flock, so the ref
    // write then fails and the leaf dies on a teardown race.
    expect(s.indexOf('flock 9')).toBeLessThan(s.indexOf('mkdir -p "$REFS"'));
  });

  it('sweeps refs left behind by a harness pod that died mid-leaf', () => {
    // Without this, one crashed harness pod pins a digest's cache forever and #216 is back for that
    // digest. The window is far longer than any turn, so it cannot evict a live leaf's ref.
    expect(s).toMatch(/find "\$REFS" -maxdepth 1 -type f -mmin \+\d+ -delete/);
  });

  it('rejects an invalid digest rather than composing a path from it', () => {
    expect(() => buildCacheAcquireScript("x'; rm -rf /; '", 'leaf-1')).toThrow(/invalid digest/i);
  });
});

describe('buildCachePopulateScript', () => {
  const s = buildCachePopulateScript(DIGEST);
  it('extracts from stdin base64, never from a heredoc per file', () => {
    expect(s).toContain('base64 -d');
    expect(s).toContain('tar -x');
  });
  it('populates under a flock, matching converge.ts discipline', () => {
    expect(s).toMatch(/flock 9[\s\S]*tar -x[\s\S]*9>"\$LOCK"/);
  });
  it('is idempotent — an existing digest dir is left alone', () => {
    expect(s).toContain('[ -d "$DIR" ] &&');
  });
  it('renames a staging dir into place so a crash cannot half-populate the cache', () => {
    expect(s).toContain('mv ');
  });
  it('makes .sh scripts executable (tar-over-exec does not preserve the bit reliably)', () => {
    expect(s).toContain('chmod +x');
  });
  it('enables pipefail so a failed base64 cannot be masked by a successful tar', () => {
    // Without pipefail the pipeline reports only tar's status, and a truncated stdin would produce
    // exit 0 with an incompletely populated cache.
    expect(s).toContain('set -euo pipefail');
  });

  it('traps EXIT to remove the staging dir, so failures do not accumulate stale dirs', () => {
    expect(s).toMatch(/trap '.*rm -rf "\$TMP"' EXIT/);
    // and the trap must be armed BEFORE extraction, or it cannot clean up a failed extract
    expect(s.indexOf('trap')).toBeLessThan(s.indexOf('base64 -d'));
  });

  it('restores write permission in the trap before rm -rf, so a read-only staged tree can still be removed on failure', () => {
    // ADR-0031 makes the staged tree read-only (chmod -R a-w) before the mv. If the trap's rm -rf
    // ever runs on that read-only tree without first restoring write permission, `rm -rf` can fail
    // to remove it (a directory needs write permission on itself to unlink its own entries), and a
    // staging dir leaks on every failure -- exactly the bug this fix must not introduce.
    expect(s).toMatch(/trap 'chmod -R u\+w "\$TMP".*rm -rf "\$TMP"' EXIT/);
  });

  it('drops write permission on the staged tree (ADR-0031: promoted memory/skills must be read-only) after chmod +x and before the mv', () => {
    const chmodExecIdx = s.indexOf('chmod +x');
    const chmodReadonlyIdx = s.indexOf('chmod -R a-w');
    const mvIdx = s.lastIndexOf('mv "$TMP" "$DIR"');
    expect(chmodExecIdx).toBeGreaterThan(-1);
    expect(chmodReadonlyIdx).toBeGreaterThan(-1);
    expect(mvIdx).toBeGreaterThan(-1);
    // Order matters: +x must land before the tree goes read-only (or the scripts it ships could
    // not be marked executable), and both must land before the mv (so the canonical shared cache
    // is never briefly writable).
    expect(chmodExecIdx).toBeLessThan(chmodReadonlyIdx);
    expect(chmodReadonlyIdx).toBeLessThan(mvIdx);
  });

  it('documents the tolerated undrained-stdin race next to the early exit', () => {
    // A future reader "fixing" this race would either reintroduce the transfer the probe avoids or
    // re-extract over a populated cache, so the reasoning has to live in the source.
    expect(s).toMatch(/race|undrained|tolerat/i);
  });

  it('single-quote-escapes the digest', () => {
    // A real sha256:<hex> digest can never contain a quote -- assertValidDigest (Fix B,
    // config-bundle's shared digest validator) now rejects this string before `sq()` ever sees
    // it, so the escaping this test used to exercise is unreachable for a value shaped this way.
    // The `sq()` helper itself is still covered structurally by every other test in this file
    // (they all pass a valid DIGEST through, and `sq()` is applied unconditionally).
    expect(() => buildCachePopulateScript("x'; rm -rf /; '")).toThrow(/invalid digest/i);
  });
});

describe('buildLeafBindScript', () => {
  const s = buildLeafBindScript(DIGEST, 'leaf-1');
  it('creates the leaf dir and links the shared cache into it', () => {
    expect(s).toContain('mkdir -p');
    expect(s).toContain('/workspace/leaves/leaf-1');
    expect(s).toContain('ln -sfn');
  });
  it('writes nothing outside the leaf path and the digest cache', () => {
    for (const line of s.split('\n')) {
      if (/^\s*(mkdir|ln|rm|mv|chmod)/.test(line)) {
        expect(line).toMatch(/\$LEAF|\$DIR|leaves|\.sh-config/);
      }
    }
  });
});

// Invoked from run-leaf.ts's runPromptLeaf teardown (in the `finally`, guarded on `overlayDigest`)
// for a promoted prompt leaf, which never converges a workspace and so has no other path that would
// ever remove this per-leaf link -- see run-leaf-promoted.test.ts for the wiring-level coverage.
describe('buildConfigCleanupScript', () => {
  const s = buildConfigCleanupScript('leaf-1', DIGEST);

  it('removes the per-leaf link', () => {
    expect(s).toContain('/workspace/leaves/leaf-1/.sh-config');
  });

  it('drops this leaf’s ref on the digest', () => {
    expect(s).toContain(`rm -f "$REFS/leaf-1"`);
  });

  it('tears the shared cache down when the last ref goes, so it cannot outlive its leaves (#216)', () => {
    expect(s).toContain(`DIR='${CACHE}'`);
    expect(s).toContain('rm -rf "$DIR"');
  });

  it('deletes the cache only when no refs remain', () => {
    // A concurrent fan-out is the reason the cache exists at all (spec §4.5: 200 leaves push the
    // bundle once). An unconditional rm here would delete it under every sibling still running.
    const guard = s.match(/\[ -z "\$\(ls -A "\$REFS" 2>\/dev\/null\)" \]/);
    expect(guard).not.toBeNull();
    expect(s.indexOf('-z "$(ls -A "$REFS"')).toBeLessThan(s.indexOf('rm -rf "$DIR"'));
  });

  it('restores write permission before rm -rf, since the cache is chmod a-w', () => {
    // ADR-0031 makes the cache read-only via `chmod -R a-w`, which clears the write bit on its
    // directories too -- and a directory needs write permission on itself to unlink its entries.
    // Without this the teardown silently fails and the cache survives, which is the bug.
    expect(s.indexOf('chmod -R u+w "$DIR"')).toBeLessThan(s.indexOf('rm -rf "$DIR"'));
  });

  it('does the whole release under the same flock the acquire and populate use', () => {
    expect(s).toContain('LOCK=/workspace/.sh-config.lock');
    expect(s).toMatch(/flock 9[\s\S]*rm -rf "\$DIR"[\s\S]*9>"\$LOCK"/);
  });

  it('sweeps stale refs before counting, so a crashed harness pod cannot pin a cache forever', () => {
    expect(s).toMatch(/find "\$REFS" -maxdepth 1 -type f -mmin \+\d+ -delete/);
  });

  it('never fails the leaf: teardown is best-effort and must not mask a verdict', () => {
    // Mirrors cleanupWorkspace (converge.ts:76). `set -e` here would turn a teardown hiccup into a
    // non-zero exit that run-leaf logs over the turn's real outcome.
    expect(s).toContain('set -u');
    expect(s).not.toContain('set -eu');
  });

  it('rejects an invalid digest rather than composing a path from it', () => {
    expect(() => buildConfigCleanupScript('leaf-1', "x'; rm -rf /; '")).toThrow(/invalid digest/i);
  });
});

// Runs the real scripts against a temp root. flock is shimmed to a no-op (macOS has none); the
// scripts' locking is pinned by the string assertions above, this block pins what they remove.
describe('cleanup scripts, executed', () => {
  let root: string;
  let bin: string;
  const sh = (script: string) =>
    execFileSync('bash', ['-c', script.replaceAll('/workspace', `${root}/workspace`)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    }).toString();
  const cache = () => `${root}${CACHE}`;
  const refs = () => `${root}${REFS}`;
  const link = (sid: string) => `${root}/workspace/leaves/${sid}/.sh-config`;
  const linkExists = (sid: string) => {
    try {
      lstatSync(link(sid));
      return true;
    } catch {
      return false;
    }
  };
  const acquireAndBind = (sid: string, refId?: string) => {
    sh(buildCacheAcquireScript(DIGEST, refId ?? sid));
    if (!existsSync(cache())) {
      mkdirSync(cache(), { recursive: true });
      writeFileSync(join(cache(), 'CLAUDE.md'), 'x');
      chmodSync(join(cache(), 'CLAUDE.md'), 0o444);
      chmodSync(cache(), 0o555);
    }
    sh(buildLeafBindScript(DIGEST, sid));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'overlay-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'workspace'));
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });
  afterEach(() => {
    if (existsSync(cache())) chmodSync(cache(), 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  it('two turns of one session: releasing one keeps the session link and the cache', () => {
    acquireAndBind('sess-1', 'sess-1.aaaa');
    acquireAndBind('sess-1', 'sess-1.bbbb');
    sh(buildConfigCleanupScript('sess-1', DIGEST, 'sess-1.aaaa'));
    expect(existsSync(join(refs(), 'sess-1.aaaa'))).toBe(false);
    expect(existsSync(join(refs(), 'sess-1.bbbb'))).toBe(true);
    expect(linkExists('sess-1')).toBe(true);
    expect(existsSync(join(cache(), 'CLAUDE.md'))).toBe(true);
  });

  it('releasing the last turn of a session removes the link and the cache', () => {
    acquireAndBind('sess-1', 'sess-1.aaaa');
    acquireAndBind('sess-1', 'sess-1.bbbb');
    sh(buildConfigCleanupScript('sess-1', DIGEST, 'sess-1.aaaa'));
    sh(buildConfigCleanupScript('sess-1', DIGEST, 'sess-1.bbbb'));
    expect(linkExists('sess-1')).toBe(false);
    expect(existsSync(cache())).toBe(false);
    expect(existsSync(refs())).toBe(false);
  });

  it('a turn release keeps the cache while another session still holds a ref', () => {
    acquireAndBind('sess-1', 'sess-1.aaaa');
    acquireAndBind('sess-2', 'sess-2.cccc');
    sh(buildConfigCleanupScript('sess-1', DIGEST, 'sess-1.aaaa'));
    expect(linkExists('sess-1')).toBe(false);
    expect(linkExists('sess-2')).toBe(true);
    expect(existsSync(join(cache(), 'CLAUDE.md'))).toBe(true);
  });

  it('the /runs single-ref leaf (no refId) still removes its link and the last cache', () => {
    acquireAndBind('leaf-1');
    acquireAndBind('leaf-2');
    sh(buildConfigCleanupScript('leaf-1', DIGEST));
    expect(linkExists('leaf-1')).toBe(false);
    expect(existsSync(join(cache(), 'CLAUDE.md'))).toBe(true);
    sh(buildConfigCleanupScript('leaf-2', DIGEST));
    expect(linkExists('leaf-2')).toBe(false);
    expect(existsSync(cache())).toBe(false);
  });

  it('without a refId the link is released by the same guard as a turn, inside the lock', () => {
    const single = buildConfigCleanupScript('leaf-1', DIGEST);
    expect(single).toBe(buildConfigCleanupScript('leaf-1', DIGEST, 'leaf-1'));
    expect(single).not.toMatch(/^rm -f '\/workspace\/leaves/m);
    expect(single).toMatch(
      /flock 9[\s\S]*\[ -n "\$KEEP" \] \|\| rm -f '\/workspace\/leaves\/leaf-1\/\.sh-config'[\s\S]*9>"\$LOCK"/,
    );
  });

  it('a /runs leaf and a /v1/turn turn of one session: neither release drops the other’s link', () => {
    acquireAndBind('sess-1');
    acquireAndBind('sess-1', 'sess-1.aaaa');
    sh(buildConfigCleanupScript('sess-1', DIGEST));
    expect(existsSync(join(refs(), 'sess-1'))).toBe(false);
    expect(linkExists('sess-1')).toBe(true);
    expect(existsSync(join(cache(), 'CLAUDE.md'))).toBe(true);
    sh(buildConfigCleanupScript('sess-1', DIGEST, 'sess-1.aaaa'));
    expect(linkExists('sess-1')).toBe(false);
    expect(existsSync(cache())).toBe(false);
  });

  it('a /v1/turn release keeps the link while the session’s /runs leaf still holds its ref', () => {
    acquireAndBind('sess-1');
    acquireAndBind('sess-1', 'sess-1.aaaa');
    sh(buildConfigCleanupScript('sess-1', DIGEST, 'sess-1.aaaa'));
    expect(linkExists('sess-1')).toBe(true);
  });

  it('rejects an unsafe refId as it does an unsafe sessionId', () => {
    for (const bad of ['../x', 'a/b', '..', 'a b', "a'b"]) {
      expect(() => buildConfigCleanupScript('sess-1', DIGEST, bad)).toThrow(/invalid sessionId/i);
      expect(() => buildCacheAcquireScript(DIGEST, bad)).toThrow(/invalid sessionId/i);
    }
    expect(() => buildConfigCleanupScript('a b', DIGEST, 'ok.1')).toThrow(/invalid sessionId/i);
  });
});

function transportSpy(cacheHit: boolean) {
  const calls: Array<{ command: string; stdinBytes: number }> = [];
  return {
    calls,
    transport: {
      exec: async (command: string, opts?: { stdin?: Buffer }) => {
        calls.push({ command, stdinBytes: opts?.stdin?.length ?? 0 });
        const acquiring = command.includes('CACHE_ACQUIRE');
        return {
          stdout: Buffer.from(acquiring && cacheHit ? 'hit' : 'miss'),
          exitCode: 0,
          truncated: false,
        };
      },
      close: async () => {},
      fastTier: 'per-call-exec' as const,
    },
  };
}

describe('overlayConfig', () => {
  const tarGz = gzipSync(Buffer.from('fake-tar'));

  it('returns the sandbox skills and memory dirs for the prompt notes', async () => {
    const { transport } = transportSpy(true);
    expect(await overlayConfig(transport, DIGEST, 'leaf-1', tarGz)).toEqual({
      skillsDir: '/workspace/leaves/leaf-1/.sh-config/skills',
      memoryDir: '/workspace/leaves/leaf-1/.sh-config/memory',
    });
  });

  it('pushes no bytes when the digest is already cached (the fan-out win)', async () => {
    const { transport, calls } = transportSpy(true);
    await overlayConfig(transport, DIGEST, 'leaf-1', tarGz);
    expect(calls.every((c) => c.stdinBytes === 0)).toBe(true);
    expect(calls).toHaveLength(2); // acquire + bind
  });

  it('pushes the bundle exactly once when the cache is cold', async () => {
    const { transport, calls } = transportSpy(false);
    await overlayConfig(transport, DIGEST, 'leaf-1', tarGz);
    expect(calls.filter((c) => c.stdinBytes > 0)).toHaveLength(1);
    expect(calls).toHaveLength(3); // acquire + populate + bind
  });

  it('registers the ref before it can ever push bytes, so a cold miss is still race-safe', async () => {
    const { transport, calls } = transportSpy(false);
    await overlayConfig(transport, DIGEST, 'leaf-1', tarGz);
    expect(calls[0]?.command).toContain('CACHE_ACQUIRE');
    expect(calls[0]?.stdinBytes).toBe(0);
  });

  it('throws on a non-zero exit rather than continuing unconfigured', async () => {
    const transport = {
      exec: async () => ({ stdout: Buffer.from(''), exitCode: 1, truncated: false }),
      close: async () => {},
      fastTier: 'per-call-exec' as const,
    };
    await expect(overlayConfig(transport, DIGEST, 'leaf-1', tarGz)).rejects.toThrow(/overlay/);
  });

  it('throws when the overlay output is truncated', async () => {
    const transport = {
      exec: async () => ({ stdout: Buffer.from(''), exitCode: null, truncated: true }),
      close: async () => {},
      fastTier: 'per-call-exec' as const,
    };
    await expect(overlayConfig(transport, DIGEST, 'leaf-1', tarGz)).rejects.toThrow(/output cap/);
  });
});
