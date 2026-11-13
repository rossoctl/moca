import { Server, ServerCredentials, status, type ServerWritableStream } from '@grpc/grpc-js';
import {
  SandboxExecService,
  Stream,
  type ExecEvent,
  type ExecRequest,
  type LeaseEvent,
} from '../../src/gen/sandbox/v1/sandbox.js';

/**
 * How the fake relay answers one Exec: its `lease` events first, then `stdout` then an End with
 * `exitCode`, or, with `refuse`, the worker's in-stream ExecError carrying that message, then the
 * relay's INTERNAL status. With `hang`, nothing follows the lease events and the stdout: only the
 * client's cancel ends the call.
 */
export type FakeExecAnswer = { lease?: LeaseEvent[] } & (
  { stdout?: string; exitCode?: number; hang?: boolean } | { refuse: string }
);

/**
 * A plain-text sandbox/v1 relay on 127.0.0.1 that answers each Exec from `answer`, given the
 * request and its bearer token. For a client's tests outside this package (mocactl's MCP server),
 * which drive a real SandboxExecConn against it. Only Exec is served.
 */
export async function fakeExecRelay(answer: (req: ExecRequest, bearer: string) => FakeExecAnswer) {
  const seen: { req: ExecRequest; bearer: string }[] = [];
  const server = new Server();
  server.addService(SandboxExecService, {
    exec: (call: ServerWritableStream<ExecRequest, ExecEvent>) => {
      const auth = String(call.metadata.get('authorization')[0] ?? '');
      const bearer = auth.replace(/^Bearer /, '');
      seen.push({ req: call.request, bearer });
      const reqId = call.request.exec?.reqId ?? 0;
      const a = answer(call.request, bearer);
      for (const lease of a.lease ?? []) call.write({ lease } as ExecEvent);
      if ('refuse' in a) {
        call.write({ error: { reqId, message: a.refuse } } as ExecEvent);
        call.emit(
          'error',
          Object.assign(new Error(a.refuse), { code: status.INTERNAL, details: a.refuse }),
        );
        return;
      }
      if (a.stdout) {
        call.write({
          chunk: { reqId, data: Buffer.from(a.stdout), stream: Stream.STREAM_STDOUT },
        } as ExecEvent);
      }
      if (a.hang) return;
      call.write({ end: { reqId, exitCode: a.exitCode ?? 0, truncated: false } } as ExecEvent);
      call.end();
    },
  });
  const port = await new Promise<number>((res, rej) =>
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (e, p) =>
      e ? rej(e) : res(p),
    ),
  );
  return { addr: `127.0.0.1:${port}`, seen, close: () => server.forceShutdown() };
}
