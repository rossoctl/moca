import { createServer } from 'node:http';
import { credentials, InterceptingCall, type Interceptor } from '@grpc/grpc-js';
import { GrpcRelayTransport, SandboxExecClient, type ExecClientLike } from '@moca/k8s-sandbox';
import { createHandler } from './server.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return v;
}

const relayAddr = required('SH_RELAY_ADDR');
const token = required('MOCA_RELAY_EXEC_TOKEN');
const sandboxId = required('SBX_SANDBOX_ID');
// microvm-worker refuses an empty key; the container worker ignores it.
const workspaceKey = process.env.SBX_WORKSPACE_KEY ?? '';
// Loopback by default: the only way in is an SSH tunnel (prototype plan, "Corners cut").
const host = process.env.SBX_HOST ?? '127.0.0.1';
const port = Number(process.env.SBX_PORT ?? '8787');

const bearer: Interceptor = (options, nextCall) =>
  new InterceptingCall(nextCall(options), {
    start(metadata, listener, next) {
      metadata.set('authorization', `Bearer ${token}`);
      next(metadata, listener);
    },
  });

const client = new SandboxExecClient(relayAddr, credentials.createInsecure(), {
  interceptors: [bearer],
}) as unknown as ExecClientLike;
const transport = GrpcRelayTransport(sandboxId, client, { workspaceKey });

const handler = createHandler(transport.exec, (rec) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), ...rec })),
);

createServer((req, res) => void handler(req, res)).listen(port, host, () => {
  console.error(
    `sandbox-mcp listening on http://${host}:${port}/mcp -> ${relayAddr} sandbox=${sandboxId} workspace=${workspaceKey || '(shared)'}`,
  );
});
