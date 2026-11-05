import {
  createBashTool,
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import type { CapacityLatch } from './capacity-latch.js';
import type { SandboxContext, SandboxTransport } from './transport.js';
import {
  createPodBashOps,
  createPodEditOps,
  createPodFindOps,
  createPodLsOps,
  createPodReadOps,
  createPodWriteOps,
} from './operations.js';
import { createPodGrepTool } from './grep-tool.js';

/**
 * The tools this extension overrides, and so the only ones a host capacity refusal says
 * anything about (#452).
 *
 * The latch's `tool_call` block is scoped to these BY NAME because an extension's
 * `tool_call` handler sees every tool in the session, not just the ones it registered.
 * A harness turn also carries tools that never cross the sandbox seam —
 * `submit_verdict` and `request_approval` on a verdict leaf — and blocking those is
 * actively harmful: a verdict the model can still reach IS the leaf's result
 * (`run-leaf.ts`, where `throwIfRefused()` deliberately fires only when nothing was
 * captured), so blocking the submit would discard finished reasoning and make the run
 * retry work it had already completed.
 *
 * Kept in sync with the `registerTool` calls below by
 * `test/extension.test.ts`, which asserts the set matches what the extension registers
 * rather than trusting this list.
 */
const SANDBOX_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'find', 'bash', 'grep']);

/**
 * Pi extension that overrides the seven built-in tools so file/search/exec run
 * in a remote sandbox over a relay transport.
 *
 * Two-tier transport:
 *  - fastTransport: a reused channel for the small request/response ops
 *    (read/write/edit/ls/find), when the transport offers one.
 *  - streamTransport: for the streaming/long-running ops (bash, grep, user `!`),
 *    which need onData/abort/long-running semantics.
 *
 * @param opts.transport  The sandbox's exec channel; overrides BOTH tiers. REQUIRED:
 *                        with the pod-exec path removed (ADR-0041) there is no config
 *                        to build a transport from and no default to fall back to, and
 *                        an extension that silently registered LOCAL tools would run
 *                        the model's bash in the harness process (MI1 §5 R3's hazard).
 *                        A caller with no sandbox simply omits the extension.
 * @param opts.podCwd     The sandbox-side working directory; head paths under the
 *                        harness cwd map here, and the model's prompt names it.
 * @param opts.sandboxId  The sandbox's id, named in the model's prompt.
 * @param opts.fastTransport   Override the FAST tier only (read/write/edit/ls/find).
 *                             Falls back to `transport`.
 * @param opts.streamTransport Override the STREAM tier only (bash, grep, user `!`).
 *                             Falls back to `transport`.
 * @param opts.capacity  A per-turn CapacityLatch. When given, a host's capacity refusal
 *                       ends the turn instead of being narrated to the model (#452); the
 *                       caller rethrows it after `session.prompt()` returns. Omitted
 *                       (every caller that is not a harness turn) keeps today's
 *                       behaviour exactly.
 */
export function k8sSandboxExtension(opts: {
  transport: SandboxTransport;
  podCwd: string;
  sandboxId?: string;
  fastTransport?: SandboxTransport;
  streamTransport?: SandboxTransport;
  capacity?: CapacityLatch;
}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    if (!opts?.transport) {
      throw new Error(
        'k8sSandboxExtension requires a transport: the Knative/KEDA pod-exec path was removed (ADR-0041); pass the leased relay transport, or omit the extension to run tools locally',
      );
    }
    const localCwd = process.cwd();
    const ctx: SandboxContext = {
      podCwd: opts.podCwd,
      headCwd: localCwd,
      ...(opts.sandboxId !== undefined ? { sandboxId: opts.sandboxId } : {}),
    };

    // THE TWO TIERS ARE RESOLVED SEPARATELY (#245), each falling through the same two
    // steps: its own override, then the both-tiers shorthand.
    //
    // ORDER MATTERS: the specific override wins over the shorthand, so passing both
    // `transport` and `fastTransport` is "both tiers go there, except the fast one".
    // The reverse precedence would make the specific knob unreachable whenever the
    // shorthand was also set, which is every existing caller.
    //
    // WRAPPED HERE, once, around the two transports every tool below draws from — rather
    // than at each of the seven registerTool sites. #452 arrives on bash most often, but
    // read/write/edit/ls/find/grep all cross the same seam and a refusal on any of them
    // is the same host condition.
    const watch = opts.capacity ? opts.capacity.watch : (t: SandboxTransport) => t;
    // Resolved BEFORE wrapping, and kept, because `watch` allocates a fresh wrapper per
    // call: with a latch supplied, `fastTransport !== streamTransport` even when both
    // resolve to the one object the `transport` shorthand named. Only these pre-wrap
    // values can answer "is there really one channel here?", which session_shutdown needs.
    const streamBase = opts.streamTransport ?? opts.transport;
    const fastBase = opts.fastTransport ?? opts.transport;
    const streamTransport = watch(streamBase);
    const fastTransport = watch(fastBase);

    // Fast request/response ops → the fast tier.
    pi.registerTool(
      createReadTool(localCwd, { operations: createPodReadOps(fastTransport.exec, ctx) }),
    );
    pi.registerTool(
      createWriteTool(localCwd, { operations: createPodWriteOps(fastTransport.exec, ctx) }),
    );
    pi.registerTool(
      createEditTool(localCwd, { operations: createPodEditOps(fastTransport.exec, ctx) }),
    );
    pi.registerTool(
      createLsTool(localCwd, { operations: createPodLsOps(fastTransport.exec, ctx) }),
    );
    pi.registerTool(
      createFindTool(localCwd, { operations: createPodFindOps(fastTransport.exec, ctx) }),
    );

    // Streaming / long-running ops → the stream tier.
    pi.registerTool(
      createBashTool(localCwd, { operations: createPodBashOps(streamTransport.exec, ctx) }),
    );
    pi.registerTool(createPodGrepTool(localCwd, streamTransport.exec, ctx));
    pi.on('user_bash', () => ({ operations: createPodBashOps(streamTransport.exec, ctx) }));

    // STOP SPENDING THE TURN ON A HOST THAT IS REFUSING WORK (#452).
    //
    // Registered only when a latch was supplied, so the handler count every other caller
    // sees is unchanged. `tool_call`'s `{block, reason}` is the ONLY loop-control result
    // Pi offers an extension — `tool_result` carries just `{content, details, isError}`,
    // with no way to terminate — and blocking is advisory: the model still gets a turn to
    // answer in prose. That is why the latch is also read by the caller after
    // `session.prompt()` resolves. This hook is not the fix; it stops the model from
    // retrying a doomed exec a dozen times first, which is what made the original report
    // read as a hang rather than an error.
    if (opts.capacity) {
      const latch = opts.capacity;
      pi.on('tool_call', (event) => {
        if (!SANDBOX_TOOLS.has(event.toolName)) return {};
        const refusal = latch.refusal();
        if (!refusal) return {};
        // The reason goes to the MODEL, so it says what to do, not what the arithmetic
        // was. The operator-facing numbers travel in the rethrown error's message.
        return { block: true, reason: 'The sandbox host is at capacity; this turn is ending.' };
      });
    }

    // Tell the model its cwd is the sandbox's, not the head's.
    pi.on('before_agent_start', (event) => {
      const modified = event.systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${opts.podCwd} (sandbox ${opts.sandboxId ?? 'remote'})`,
      );
      return { systemPrompt: modified };
    });

    // Release the transports' long-lived resources so they are never leaked.
    //
    // BOTH TIERS, and that is new with #245. Closing the fast tier alone was sufficient
    // while the stream tier was the SAME OBJECT (the `transport` shorthand); a caller
    // passing a `streamTransport` that owns something — a GrpcRelayTransport owns its
    // gRPC channel — would have leaked it once per session.
    //
    // Guarded on the PRE-WRAP identity rather than relying on idempotency: close() is
    // contractually idempotent, so a double close is safe, but the shorthand makes these
    // one object on every existing caller and closing it twice there is pointless work on
    // a path that runs for every session.
    pi.on('session_shutdown', async () => {
      await fastTransport.close();
      if (streamBase !== fastBase) await streamTransport.close();
    });
  };
}
