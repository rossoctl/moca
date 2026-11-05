import { describe, expect, it, vi } from 'vitest';

import { SandboxCapacityRefusedError, type SandboxTransport } from '../src/transport.js';
import { k8sSandboxExtension } from '../src/extension.js';
import { createCapacityLatch } from '../src/capacity-latch.js';

/** Minimal ExtensionAPI stub recording registrations + event handlers. */
function fakePi() {
  const tools: unknown[] = [];
  const handlers: Record<string, (...a: unknown[]) => unknown> = {};
  const pi = {
    registerTool: (t: unknown) => tools.push(t),
    on: (name: string, h: (...a: unknown[]) => unknown) => {
      handlers[name] = h;
    },
  } as unknown as Parameters<ReturnType<typeof k8sSandboxExtension>>[0];
  return { pi, tools, handlers };
}

const okTransport = (close = vi.fn(async () => {})): SandboxTransport => ({
  exec: async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false }),
  close,
  // A hand-written transport must now choose a tier (#245). `'per-call-exec'` is the
  // honest answer for a stub with no channel to reuse, and it is also what the real
  // callers hand to `transport:` — the case this file's two-tier tests are about.
  fastTier: 'per-call-exec',
});

/**
 * A transport that records every command it is given, so a test can assert WHICH tier a
 * tool reached rather than that some exec happened (#245). The label is carried only to
 * make a failure message say which transport was called.
 */
function tagging(label: string) {
  const calls: string[] = [];
  const transport: SandboxTransport = {
    exec: async (command) => {
      calls.push(`${label}:${command}`);
      return { stdout: Buffer.from(''), exitCode: 0, truncated: false };
    },
    close: vi.fn(async () => {}),
    fastTier: 'per-call-exec',
  };
  return { transport, calls };
}

/** Run one of the extension's registered tools by name. */
const exec = async (tools: unknown[], name: string, args: Record<string, unknown>) => {
  const tool = (
    tools as Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }>
  ).find((t) => t.name === name)!;
  await tool.execute('call-1', args).catch(() => {});
};

describe('k8sSandboxExtension', () => {
  it('throws when no transport is given: never installs local-running tools', () => {
    // The off-gate used to be a null config (local tools stand). With the pod-exec path gone
    // (ADR-0041) there is no config and no default transport: a caller that reaches the
    // extension without a transport is misconfigured, and silently registering LOCAL tools
    // would run the model's bash in the harness process — MI1 §5 R3's exact hazard.
    const { pi, tools } = fakePi();
    expect(() => k8sSandboxExtension({ podCwd: '/workspace' } as never)(pi)).toThrow(
      /k8sSandboxExtension requires a transport/,
    );
    expect(tools).toHaveLength(0);
  });

  it('registers the seven pod tools and wires the lifecycle handlers', () => {
    const { pi, tools, handlers } = fakePi();
    k8sSandboxExtension({ podCwd: '/workspace', transport: okTransport() })(pi);
    expect(tools).toHaveLength(7);
    expect(typeof handlers.user_bash).toBe('function');
    expect(typeof handlers.before_agent_start).toBe('function');
    expect(typeof handlers.session_shutdown).toBe('function');
  });

  it('closes the fast channel on session_shutdown', async () => {
    const close = vi.fn(async () => {});
    const { pi, handlers } = fakePi();
    k8sSandboxExtension({ podCwd: '/workspace', transport: okTransport(close) })(pi);
    await handlers.session_shutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('sends fast ops to the fast tier and streaming ops to the stream tier (#245)', async () => {
    // THE DEFECT. `transport` meant BOTH tiers, so a caller with a per-call transport —
    // run-leaf.ts, passing a leased GrpcRelayTransport — silently gave up the fast tier for
    // every read/write/edit/ls/find. The two can now be given separately, and this pins
    // WHICH tier each tool draws from, so a future reshuffle of the registerTool block
    // cannot quietly move a file op onto the streaming transport or the reverse.
    const fast = tagging('fast');
    const stream = tagging('stream');
    const { pi, tools } = fakePi();
    k8sSandboxExtension({
      podCwd: '/workspace',
      transport: okTransport(),
      fastTransport: fast.transport,
      streamTransport: stream.transport,
    })(pi);

    await exec(tools, 'ls', { path: '/workspace' });
    // Counts are not asserted — `ls` legitimately issues more than one exec (an existence
    // probe, then the listing) and that is the tool's business. What must hold is that
    // every one of them went to the fast tier and none leaked to the stream tier.
    expect(fast.calls.length).toBeGreaterThan(0);
    expect(stream.calls).toHaveLength(0);

    const afterLs = fast.calls.length;
    await exec(tools, 'bash', { command: 'echo hi' });
    expect(fast.calls).toHaveLength(afterLs); // bash must not touch the fast channel
    expect(stream.calls.length).toBeGreaterThan(0);
  });

  it('lets the specific tier override win over the both-tiers shorthand (#245)', async () => {
    // Order matters in the three-step fallthrough: own override, then `transport`, then the
    // tier's default. The reverse precedence would make the new knobs unreachable for every
    // existing caller, since all of them set `transport`.
    const both = tagging('both');
    const fast = tagging('fast');
    const { pi, tools } = fakePi();
    k8sSandboxExtension({
      podCwd: '/workspace',
      transport: both.transport,
      fastTransport: fast.transport,
    })(pi);

    await exec(tools, 'ls', { path: '/workspace' });
    const afterLs = both.calls.length;
    await exec(tools, 'bash', { command: 'echo hi' });
    // "both tiers go there, except the fast one": `ls` reached the override and left the
    // shorthand untouched, and `bash` then reached the shorthand.
    expect(fast.calls.length).toBeGreaterThan(0);
    expect(afterLs).toBe(0);
    expect(both.calls.length).toBeGreaterThan(0);
  });

  it('closes BOTH tiers on session_shutdown when they are different objects (#245)', async () => {
    // New with the split. Closing only the fast tier was sufficient while the stream tier was
    // either the same object or a KubectlTransport (no-op close); a streamTransport that owns
    // something — a GrpcRelayTransport owns its gRPC channel — would leak once per session.
    const fastClose = vi.fn(async () => {});
    const streamClose = vi.fn(async () => {});
    const { pi, handlers } = fakePi();
    k8sSandboxExtension({
      podCwd: '/workspace',
      transport: okTransport(),
      fastTransport: okTransport(fastClose),
      streamTransport: okTransport(streamClose),
    })(pi);
    await handlers.session_shutdown();
    expect(fastClose).toHaveBeenCalledTimes(1);
    expect(streamClose).toHaveBeenCalledTimes(1);
  });

  it('closes the shorthand transport ONCE even with a capacity latch attached (#245)', async () => {
    // The latch's `watch` allocates a FRESH wrapper per call, so post-wrap the two tiers are
    // never identical even when `transport` named one object. A naive identity guard on the
    // wrappers would double-close here. close() is contractually idempotent, so this is about
    // not doing pointless work on a path that runs for every session — and about the guard
    // meaning what it says.
    const close = vi.fn(async () => {});
    const { pi, handlers } = fakePi();
    k8sSandboxExtension({
      podCwd: '/workspace',
      transport: okTransport(close),
      capacity: createCapacityLatch(),
    })(pi);
    await handlers.session_shutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('never sends the harness process environment to the sandbox through the bash tool', async () => {
    const commands: string[] = [];
    const recording: SandboxTransport = {
      exec: async (command) => {
        commands.push(command);
        return { stdout: Buffer.from(''), exitCode: 0, truncated: false };
      },
      close: vi.fn(async () => {}),
      fastTier: 'per-call-exec',
    };
    const saved = process.env.MI1_PLANTED_SECRET;
    process.env.MI1_PLANTED_SECRET = 'planted-value-must-not-cross'; // notsecret
    try {
      const { pi, tools } = fakePi();
      k8sSandboxExtension({ podCwd: '/workspace', transport: recording })(pi);
      const bash = (
        tools as Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }>
      ).find((t) => t.name === 'bash')!;
      await bash.execute('call-1', { command: 'echo hi' });
      expect(commands).toHaveLength(1);
      expect(commands[0]).not.toContain('planted-value-must-not-cross');
      expect(commands[0]).not.toContain('MI1_PLANTED_SECRET');
    } finally {
      if (saved === undefined) delete process.env.MI1_PLANTED_SECRET;
      else process.env.MI1_PLANTED_SECRET = saved;
    }
  });
});

/**
 * #452. The extension is where a host's capacity refusal is caught on its way past — for
 * all seven tools at once — and where the agent loop is told to stop spending turns on a
 * sandbox that is refusing work.
 */
describe('k8sSandboxExtension capacity latch', () => {
  const refusing = (): SandboxTransport => ({
    exec: async () => {
      throw new SandboxCapacityRefusedError('memory-budget: committing 301989888 more bytes');
    },
    close: vi.fn(async () => {}),
    fastTier: 'per-call-exec',
  });

  const runBash = async (tools: unknown[]) => {
    const bash = (
      tools as Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }>
    ).find((t) => t.name === 'bash')!;
    // Not awaited expecting a rejection: Pi's bash tool catches the throw and reports it
    // as tool content, which is precisely the behaviour the latch exists to work around.
    await bash.execute('call-1', { command: 'pytest -x' }).catch(() => {});
  };

  // A `tool_call` event for one of the extension's OWN tools. The handler is scoped by
  // `toolName` (see SANDBOX_TOOLS), so every assertion about blocking has to name a tool
  // or it passes for the wrong reason.
  const callOf = (toolName: string) => ({ type: 'tool_call', toolCallId: 'c1', toolName });
  const sandboxCall = () => callOf('bash');

  it('registers no tool_call handler when no latch is supplied', () => {
    // Keeps every existing caller's handler set exactly as it was. The hook is a hard stop
    // on a turn and must not appear on a path with nothing to read the latch afterwards.
    const { pi, handlers } = fakePi();
    k8sSandboxExtension({ podCwd: '/workspace', transport: okTransport() })(pi);
    expect(handlers.tool_call).toBeUndefined();
  });

  it('latches a refusal that passes through a tool, and then blocks the loop', async () => {
    const capacity = createCapacityLatch();
    const { pi, tools, handlers } = fakePi();
    k8sSandboxExtension({ podCwd: '/workspace', transport: refusing(), capacity })(pi);

    // Transparent until a refusal is seen, or it would end every turn it is attached to.
    expect(handlers.tool_call(sandboxCall(), {})).toEqual({});
    expect(capacity.refusal()).toBeUndefined();

    await runBash(tools);

    expect(capacity.refusal()).toBeInstanceOf(SandboxCapacityRefusedError);
    expect(handlers.tool_call(sandboxCall(), {})).toMatchObject({ block: true });
    // The reason reaches the MODEL, so it must not quote the host's byte arithmetic — that
    // is for the operator, and it travels in the rethrown error.
    const reason = (handlers.tool_call(sandboxCall(), {}) as { reason: string }).reason;
    expect(reason).not.toMatch(/\d{6,}/);
    expect(() => capacity.throwIfRefused()).toThrow(SandboxCapacityRefusedError);
  });

  it('does not latch an ordinary tool failure', async () => {
    // A failing command must stay a failing command: latching one would end the turn and
    // answer 503 + Retry-After for a sandbox that is working perfectly well.
    const capacity = createCapacityLatch();
    const { pi, tools, handlers } = fakePi();
    const failing: SandboxTransport = {
      exec: async () => {
        throw new Error('exit status 1');
      },
      close: vi.fn(async () => {}),
      fastTier: 'per-call-exec',
    };
    k8sSandboxExtension({ podCwd: '/workspace', transport: failing, capacity })(pi);
    await runBash(tools);
    expect(capacity.refusal()).toBeUndefined();
    expect(handlers.tool_call(sandboxCall(), {})).toEqual({});
    expect(() => capacity.throwIfRefused()).not.toThrow();
  });

  it('blocks only the tools it registered, so a verdict can still be submitted', async () => {
    // An extension's `tool_call` handler sees EVERY tool in the session, not only its own.
    // A verdict leaf also carries submit_verdict and request_approval, which never cross
    // the sandbox seam — and run-leaf.ts only calls throwIfRefused() when nothing was
    // captured, precisely so a verdict the model can still reach becomes the leaf's
    // result. Blocking the submit would discard finished reasoning and send the run back
    // to redo it.
    const capacity = createCapacityLatch();
    const { pi, tools, handlers } = fakePi();
    k8sSandboxExtension({ podCwd: '/workspace', transport: refusing(), capacity })(pi);
    await runBash(tools);
    expect(capacity.refusal()).toBeInstanceOf(SandboxCapacityRefusedError);

    // Latched, so every sandbox tool is blocked...
    for (const name of ['read', 'write', 'edit', 'ls', 'find', 'bash', 'grep']) {
      expect(handlers.tool_call(callOf(name), {})).toMatchObject({ block: true });
    }
    // ...and nothing else is.
    for (const name of ['submit_verdict', 'request_approval']) {
      expect(handlers.tool_call(callOf(name), {})).toEqual({});
    }
  });

  it('scopes the block to exactly the tools the extension registers', async () => {
    // Pins the SANDBOX_TOOLS set against the REGISTRATIONS rather than trusting the list.
    // An eighth pod tool added without updating the set would ship a tool whose refusals
    // the model keeps retrying through a doomed turn; this fails instead.
    const capacity = createCapacityLatch();
    const { pi, tools, handlers } = fakePi();
    k8sSandboxExtension({ podCwd: '/workspace', transport: refusing(), capacity })(pi);
    const registered = (tools as Array<{ name: string }>).map((t) => t.name).sort();

    await runBash(tools);

    const blocked = registered
      .filter((name) => (handlers.tool_call(callOf(name), {}) as { block?: boolean }).block)
      .sort();
    expect(blocked).toEqual(registered);
  });

  it('keeps the FIRST refusal, which is the one that describes the host', async () => {
    const capacity = createCapacityLatch();
    const { pi, tools } = fakePi();
    let n = 0;
    const transport: SandboxTransport = {
      exec: async () => {
        throw new SandboxCapacityRefusedError(`memory-budget: refusal ${++n}`);
      },
      close: vi.fn(async () => {}),
      fastTier: 'per-call-exec',
    };
    k8sSandboxExtension({ podCwd: '/workspace', transport, capacity })(pi);
    await runBash(tools);
    await runBash(tools);
    expect(capacity.refusal()?.message).toBe('memory-budget: refusal 1');
  });

  it("is independent per latch: one turn's refusal never fails another turn", async () => {
    // The reason the latch is an object the caller creates rather than module state — a
    // replica serves many turns at once, against different hosts.
    const mine = createCapacityLatch();
    const theirs = createCapacityLatch();
    const { pi: piA, tools: toolsA } = fakePi();
    const { pi: piB } = fakePi();
    k8sSandboxExtension({ podCwd: '/workspace', transport: refusing(), capacity: theirs })(piA);
    k8sSandboxExtension({ podCwd: '/workspace', transport: okTransport(), capacity: mine })(piB);
    await runBash(toolsA);
    expect(theirs.refusal()).toBeInstanceOf(SandboxCapacityRefusedError);
    expect(mine.refusal()).toBeUndefined();
  });
});
