import { describe, expect, it, vi } from 'vitest';

import { attachPromotedConfig } from '../src/promoted-config.js';

const digest = 'sha256:' + 'c'.repeat(64);
const fakePromoted = {
  digest,
  root: '/tmp/sh-config/x',
  skillsDir: '/tmp/sh-config/x/skills',
  promptsDir: '/tmp/sh-config/x/prompts',
  context: [],
  promptFragments: [],
  entries: [{ path: 'skills/k/SKILL.md', content: Buffer.from('b') }],
};
const paths = {
  skillsDir: '/workspace/leaves/s1/.sh-config/skills',
  memoryDir: '/workspace/leaves/s1/.sh-config/memory',
};

/** A caller-owned relay transport: records execs, closes only if the (absent) owner says so. */
function fakeTransport() {
  return {
    exec: vi.fn(async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false })),
    close: vi.fn(async () => {}),
    fastTier: 'per-call-exec' as const,
  };
}
const sandbox = { transport: fakeTransport() };
const base = (over: Record<string, unknown> = {}) => ({
  digest,
  sessionId: 's1',
  sandbox,
  deps: {
    bundleRedis: {} as never,
    resolvePromotedConfig: vi.fn(async () => fakePromoted),
    overlayConfig: vi.fn(async () => paths),
  },
  ...over,
});

describe('attachPromotedConfig', () => {
  it('resolves only, and detaches as a no-op, when there is no sandbox', async () => {
    const opts = base({ sandbox: null });
    const a = await attachPromotedConfig(opts);
    expect(a.promotedConfig).toBe(fakePromoted);
    expect(opts.deps.overlayConfig).not.toHaveBeenCalled();
    await a.detach();
  });

  it('overlays on the caller-owned transport, advertises sandbox paths, and never closes it', async () => {
    const a = await attachPromotedConfig(base());
    expect(a.promotedConfig.sandboxSkillsDir).toBe(paths.skillsDir);
    expect(a.promotedConfig.promptFragments.at(-1)).toContain(`Skill files: ${paths.skillsDir}`);
    await a.detach();
    // The teardown runs through the caller-owned transport...
    expect(sandbox.transport.exec).toHaveBeenCalledWith(
      expect.stringContaining('/workspace/leaves/s1/.sh-config'),
      expect.objectContaining({ timeout: 60 }),
    );
    // ...but the lease lifecycle owns it (ADR-0041 removed the KubectlTransport fallback);
    // an attach must never close what it did not create.
    expect(sandbox.transport.close).not.toHaveBeenCalled();
  });

  it('keys the ref by refId while the session link stays on sessionId', async () => {
    const transport = fakeTransport();
    const opts = base({ refId: 's1.abc123', sandbox: { transport } });
    const a = await attachPromotedConfig(opts);
    expect(opts.deps.overlayConfig).toHaveBeenCalledWith(
      transport,
      digest,
      's1',
      expect.any(Buffer),
      's1.abc123',
    );
    await a.detach();
    const script = (transport.exec.mock.calls[0] as unknown as [string])[0];
    expect(script).toContain('rm -f "$REFS/s1.abc123"');
    expect(script).not.toContain('rm -f "$REFS/s1"');
    expect(script).toContain("'/workspace/leaves/s1/.sh-config'");
  });

  it('tears the partial overlay down and rethrows when the overlay fails (#216)', async () => {
    const transport = fakeTransport();
    const opts = base({ sandbox: { transport } });
    opts.deps.overlayConfig = vi.fn(async () => {
      throw new Error('config overlay failed (exit 1)');
    });
    await expect(attachPromotedConfig(opts)).rejects.toThrow('config overlay failed');
    // The teardown runs through the SAME transport the overlay attempted.
    expect(transport.exec).toHaveBeenCalledWith(
      expect.stringContaining(`.refs/sha256-${'c'.repeat(64)}`),
      expect.objectContaining({ timeout: 60 }),
    );
  });

  it('detach is idempotent and swallows teardown errors', async () => {
    const transport = fakeTransport();
    const a = await attachPromotedConfig(base({ sandbox: { transport } }));
    transport.exec.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await expect(a.detach()).resolves.toBeUndefined();
    await a.detach();
    expect(transport.exec).toHaveBeenCalledTimes(1); // ONE teardown, however often detach runs
  });

  it('propagates a resolve failure without touching the sandbox', async () => {
    const transport = fakeTransport();
    const opts = base({ sandbox: { transport } });
    opts.deps.resolvePromotedConfig = vi.fn(async () => {
      throw new Error('config bundle not found: ' + digest);
    });
    await expect(attachPromotedConfig(opts)).rejects.toThrow(digest);
    expect(transport.exec).not.toHaveBeenCalled();
  });
});
