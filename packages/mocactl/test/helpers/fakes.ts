import { ApiError, TurnCancelledError } from '../../src/api/errors.js';
import type { DoneFrame, TurnFrame } from '../../src/api/frames.js';
import type {
  AttachArgs,
  CancelTurnArgs,
  ControlPlaneApi,
  CredentialDescriptor,
  HarnessApi,
  StreamTurnArgs,
} from '../../src/api/types.js';

export function credential(
  name: string,
  over: Partial<CredentialDescriptor> = {},
): CredentialDescriptor {
  return {
    name,
    kind: 'bearer',
    consumer: 'inference',
    destination: { hosts: [] },
    binding: { header: 'Authorization', format: 'Bearer {token}' },
    endpoint: `https://${name}.example/v1`,
    ...over,
  };
}

export function fakeControlPlane(
  over: Partial<ControlPlaneApi> = {},
): ControlPlaneApi & { calls: string[] } {
  const calls: string[] = [];
  const defaults: ControlPlaneApi = {
    healthz: async () => undefined,
    readyz: async () => undefined,
    discovery: async () => ({ harnessUrl: 'http://h' }),
    startDeviceAuth: async () => ({
      deviceCode: 'd',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      interval: 5,
      expiresIn: 900,
    }),
    pollDeviceAuth: async () => 'pending',
    refreshAuth: async () => {
      throw new ApiError('control-plane', 400, 'invalid_grant');
    },
    revokeAuth: async () => undefined,
    revokeAllAuth: async () => 0,
    me: async () => ({ subject: 'github:1', tenant: 't', roles: [] }),
    listSessions: async () => ({ sessions: [], nextCursor: null }),
    createSession: async () => ({ sessionId: 's-new', token: 'st', expiresAt: 4_000_000_000 }),
    getSession: async (id) => ({
      sessionId: id,
      owner: 'github:1',
      tenant: 't',
      createdAt: 0,
      state: 'active',
      lastTurnAt: null,
      turns: 0,
      configRef: null,
    }),
    deleteSession: async () => 'deleted',
    mintSessionToken: async () => ({ token: 'st2', expiresAt: 4_000_000_000 }),
    listCredentials: async () => [],
    putCredential: async () => undefined,
    deleteCredential: async () => undefined,
    putConfigBundle: async (req) => ({ digest: req.digest, uploaded: true }),
    deleteConfigBundle: async () => undefined,
  };
  const merged = { ...defaults, ...over };
  const recorded = Object.fromEntries(
    Object.entries(merged).map(([k, fn]) => [
      k,
      (...args: unknown[]) => {
        calls.push(k);
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as ControlPlaneApi;
  return Object.assign(recorded, { calls });
}

export type HarnessStep = {
  frames?: TurnFrame[];
  error?: Error;
  hang?: boolean;
  // Awaited before the first frame is yielded — lets a test insert a real gap (e.g. to bump a
  // fake clock) between turn-start and the first 'frame' event.
  wait?: () => Promise<void>;
  // SSE ids, by frame index: onEventId is called with ids[i] just before frames[i] is yielded.
  ids?: string[];
};

export const doneFrame = (sessionId = 's1'): DoneFrame => ({
  type: 'done',
  sessionId,
  stopReason: 'end_turn',
});

export function fakeHarness(
  steps: HarnessStep[],
  over: Partial<HarnessApi> = {},
  attachSteps: HarnessStep[] = [],
): HarnessApi & {
  turns: StreamTurnArgs[];
  attaches: AttachArgs[];
  cancels: CancelTurnArgs[];
  attachQueuePush(step: HarnessStep): void;
} {
  const turns: StreamTurnArgs[] = [];
  const attaches: AttachArgs[] = [];
  const cancels: CancelTurnArgs[] = [];
  const queue = [...steps];
  const attachQueue = [...attachSteps];
  async function* play(step: HarnessStep, args: StreamTurnArgs | AttachArgs) {
    if (step.wait) await step.wait();
    for (const [i, f] of (step.frames ?? []).entries()) {
      const id = step.ids?.[i];
      if (id !== undefined) args.onEventId?.(id);
      yield f;
    }
    if (step.hang) {
      await new Promise<void>((resolve) => {
        if (args.signal?.aborted) return resolve();
        args.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new TurnCancelledError();
    }
    if (step.error) throw step.error;
  }
  return {
    turns,
    attaches,
    cancels,
    attachQueuePush: (step: HarnessStep) => {
      attachQueue.push(step);
    },
    baseUrl: async () => 'http://h',
    health: async () => undefined,
    probeTrust: async () => 'trusted',
    async *streamTurn(args: StreamTurnArgs) {
      turns.push(args);
      yield* play(queue.shift() ?? { frames: [doneFrame(args.sessionId)] }, args);
    },
    async *attach(args: AttachArgs) {
      attaches.push(args);
      const step = attachQueue.shift();
      if (!step) throw new ApiError('harness', 404, 'turn_not_found');
      yield* play(step, args);
    },
    // As the server does: the 202 names the cancelled turn (the given one, if any).
    async cancelTurn(args: CancelTurnArgs) {
      cancels.push(args);
      return args.turnId !== undefined ? { turnId: args.turnId } : {};
    },
    ...over,
  };
}
