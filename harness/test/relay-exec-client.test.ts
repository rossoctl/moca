import { Server, ServerCredentials, type ServerWritableStream } from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import { Exec, SandboxExecService } from '@moca/k8s-sandbox';
import { makeRelayExecClient } from '../src/select-sandbox.js';

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.forceShutdown()));

describe('the worker authenticates to relay SandboxExec (MI1 R5)', () => {
  it('sends authorization: Bearer <MOCA_RELAY_EXEC_TOKEN> on Exec', async () => {
    let seen: unknown;
    const server = new Server();
    server.addService(SandboxExecService, {
      exec: (call: ServerWritableStream<unknown, unknown>) => {
        seen = call.metadata.get('authorization')[0];
        call.end();
      },
      abort: (_call: unknown, cb: (e: null, r: object) => void) => cb(null, {}),
    });
    servers.push(server);
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (e, p) =>
        e ? reject(e) : resolve(p),
      ),
    );
    const client = makeRelayExecClient(`127.0.0.1:${port}`, 'exec-tok') as unknown as {
      exec: (req: unknown) => NodeJS.EventEmitter;
      close: () => void;
    };
    await new Promise<void>((resolve) => {
      const call = client.exec({
        sandboxId: 's',
        exec: Exec.fromPartial({
          reqId: 1,
          command: 'true',
          stdin: new Uint8Array(),
          timeoutS: 5,
          streaming: true,
          workspaceKey: '',
        }),
      });
      call.on('data', () => {});
      call.on('end', () => resolve());
      call.on('error', () => resolve());
    });
    client.close();
    expect(seen).toBe('Bearer exec-tok');
  });
});
