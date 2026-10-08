import { defaultRunKubectl, type RunKubectl } from '@moca/control-plane';
import { setTimeout as delay } from 'node:timers/promises';

interface WorkloadRuntimeBase {
  workloadId: string;
  replicas: number;
}

export type WorkloadRuntimeSpec = WorkloadRuntimeBase &
  (
    | {
        workspace: {
          kind: 'native';
          size: string;
          storageClass?: string;
        };
      }
    | {
        workspace: {
          kind: 'context';
          claimName: string;
          revision: string;
        };
      }
  );

export interface WorkloadRuntimeStatus {
  status: 'provisioning' | 'ready';
  readyReplicas: number;
  sandboxSelector: string;
}

const selectorFor = (workloadId: string): string => `moca.rossoctl.io/workload=${workloadId}`;

const sandboxName = (workloadId: string, index: number): string => `sandbox-${workloadId}-${index}`;

const workspaceClaimName = (workloadId: string, index: number): string =>
  `workspace-${sandboxName(workloadId, index)}`;

const WORKLOAD_DELETE_TIMEOUT_MS = 60_000;
const WORKLOAD_DELETE_POLL_INTERVAL_MS = 500;

function namespace(): string {
  return process.env.POD_NAMESPACE?.trim() || 'default';
}

function sandboxImage(): string {
  return process.env.MOCA_SANDBOX_IMAGE?.trim() || 'ghcr.io/rossoctl/moca-sandbox:latest';
}

function sandboxServiceAccount(): string {
  return process.env.MOCA_SANDBOX_SERVICE_ACCOUNT?.trim() || 'serverless-harness-sandbox';
}

export function sandboxResource(spec: WorkloadRuntimeSpec, index: number): Record<string, unknown> {
  if (spec.workspace.kind === 'context' && !/^[a-f0-9]{64}$/.test(spec.workspace.revision)) {
    throw new Error('workload revision must be a lowercase SHA-256 digest');
  }
  const labels = { 'moca.rossoctl.io/workload': spec.workloadId, app: 'sandbox' };
  const noServiceAccountToken = false;
  const workspace = spec.workspace;
  const volumeClaimTemplates =
    workspace.kind === 'native'
      ? [
          {
            metadata: { name: 'workspace' },
            spec: {
              accessModes: ['ReadWriteOnce'],
              resources: { requests: { storage: workspace.size } },
              ...(workspace.storageClass ? { storageClassName: workspace.storageClass } : {}),
            },
          },
        ]
      : undefined;
  const volumeMount =
    workspace.kind === 'context'
      ? {
          name: 'workspace',
          mountPath: '/workspace',
          subPath: `.context-service/materialized/${workspace.revision}`,
          readOnly: true,
        }
      : { name: 'workspace', mountPath: '/workspace' };
  const volumes =
    workspace.kind === 'context'
      ? [
          {
            name: 'workspace',
            persistentVolumeClaim: { claimName: workspace.claimName, readOnly: true },
          },
        ]
      : undefined;
  return {
    apiVersion: 'agents.x-k8s.io/v1beta1',
    kind: 'Sandbox',
    metadata: { name: sandboxName(spec.workloadId, index), namespace: namespace(), labels },
    spec: {
      ...(volumeClaimTemplates ? { volumeClaimTemplates } : {}),
      podTemplate: {
        metadata: { labels },
        spec: {
          serviceAccountName: sandboxServiceAccount(),
          automountServiceAccountToken: noServiceAccountToken,
          securityContext: {
            runAsUser: 65532,
            runAsNonRoot: true,
            fsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'sandbox',
              image: sandboxImage(),
              command: ['sleep', 'infinity'],
              workingDir: '/workspace',
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [volumeMount],
              resources: {
                requests: { memory: '64Mi', cpu: '50m' },
                limits: { memory: '256Mi' },
              },
            },
          ],
          ...(volumes ? { volumes } : {}),
        },
      },
    },
  };
}

export async function createWorkloadRuntime(
  spec: WorkloadRuntimeSpec,
  runKubectl: RunKubectl = defaultRunKubectl,
): Promise<WorkloadRuntimeStatus> {
  const created: string[] = [];
  try {
    for (let index = 0; index < spec.replicas; index += 1) {
      await runKubectl(
        ['apply', '--filename=/dev/stdin'],
        JSON.stringify(sandboxResource(spec, index)),
      );
      created.push(sandboxName(spec.workloadId, index));
    }
  } catch (error) {
    if (created.length > 0) {
      await runKubectl([
        'delete',
        'sandboxes.agents.x-k8s.io',
        ...created,
        '-n',
        namespace(),
        '--ignore-not-found',
      ]).catch(() => undefined);
      if (spec.workspace.kind === 'native') {
        await runKubectl([
          'delete',
          'persistentvolumeclaims',
          ...created.map((_name, index) => workspaceClaimName(spec.workloadId, index)),
          '-n',
          namespace(),
          '--ignore-not-found',
        ]).catch(() => undefined);
      }
    }
    throw error;
  }
  return {
    status: 'provisioning',
    readyReplicas: 0,
    sandboxSelector: selectorFor(spec.workloadId),
  };
}

export async function getWorkloadRuntime(
  workloadId: string,
  replicas: number,
  runKubectl: RunKubectl = defaultRunKubectl,
): Promise<WorkloadRuntimeStatus> {
  const raw = await runKubectl([
    'get',
    'pods',
    '-n',
    namespace(),
    '-l',
    selectorFor(workloadId),
    '-o',
    'json',
  ]);
  const list = JSON.parse(raw) as {
    items?: Array<{ status?: { conditions?: Array<{ type?: string; status?: string }> } }>;
  };
  const readyReplicas = (list.items ?? []).filter((pod) =>
    pod.status?.conditions?.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    ),
  ).length;
  return {
    status: readyReplicas >= replicas ? 'ready' : 'provisioning',
    readyReplicas,
    sandboxSelector: selectorFor(workloadId),
  };
}

export async function deleteWorkloadRuntime(
  workloadId: string,
  replicas: number,
  deleteNativeWorkspaces = false,
  runKubectl: RunKubectl = defaultRunKubectl,
  wait: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const names = Array.from({ length: replicas }, (_, index) => sandboxName(workloadId, index));
  if (names.length === 0) return;
  await runKubectl([
    'delete',
    'sandboxes.agents.x-k8s.io',
    ...names,
    '-n',
    namespace(),
    '--ignore-not-found',
  ]);
  const deadline = Date.now() + (wait.timeoutMs ?? WORKLOAD_DELETE_TIMEOUT_MS);
  while (true) {
    const raw = await runKubectl([
      'get',
      'pods',
      '-n',
      namespace(),
      '-l',
      selectorFor(workloadId),
      '-o',
      'json',
    ]);
    const pods = JSON.parse(raw) as { items?: unknown[] };
    if ((pods.items ?? []).length === 0) break;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for workload ${workloadId} pods to terminate`);
    }
    await delay(wait.pollIntervalMs ?? WORKLOAD_DELETE_POLL_INTERVAL_MS);
  }
  if (deleteNativeWorkspaces) {
    await runKubectl([
      'delete',
      'persistentvolumeclaims',
      ...Array.from({ length: replicas }, (_, index) => workspaceClaimName(workloadId, index)),
      '-n',
      namespace(),
      '--ignore-not-found',
    ]);
  }
}
