import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAllDocuments } from 'yaml';

import {
  createWorkloadRuntime,
  deleteWorkloadRuntime,
  getWorkloadRuntime,
  sandboxResource,
} from '../src/workload-runtime.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Moca workload runtime', () => {
  it('grants the harness the verbs required for retry-safe Sandbox apply and cleanup', () => {
    const documents = parseAllDocuments(
      readFileSync(resolve(REPO_ROOT, 'deploy/knative/service.yaml'), 'utf8'),
    ).map((document) => document.toJS());
    const role = documents.find(
      (document) =>
        document.kind === 'Role' && document.metadata?.name === 'serverless-harness-sandbox',
    );
    const rule = role?.rules?.find(
      (candidate: { apiGroups?: string[]; resources?: string[] }) =>
        candidate.apiGroups?.some((apiGroup) => apiGroup === 'agents.x-k8s.io') &&
        candidate.resources?.includes('sandboxes'),
    );

    expect(rule?.verbs).toEqual(
      expect.arrayContaining(['create', 'get', 'list', 'patch', 'update', 'delete']),
    );
    const pvcRule = role?.rules?.find(
      (candidate: { apiGroups?: string[]; resources?: string[] }) =>
        candidate.apiGroups?.includes('') &&
        candidate.resources?.includes('persistentvolumeclaims'),
    );
    expect(pvcRule?.verbs).toContain('delete');
  });

  it('builds a read-only Sandbox over the Context Service PVC', () => {
    vi.stubEnv('POD_NAMESPACE', 'moca');
    vi.stubEnv('MOCA_SANDBOX_IMAGE', 'example.test/moca-sandbox:v1');
    const revision = 'a'.repeat(64);
    const resource = sandboxResource(
      {
        workloadId: 'delegate-abc',
        replicas: 1,
        workspace: {
          kind: 'context',
          claimName: 'context-opaque',
          revision,
        },
      },
      0,
    ) as any;

    expect(resource.metadata).toMatchObject({
      name: 'sandbox-delegate-abc-0',
      namespace: 'moca',
      labels: { 'moca.rossoctl.io/workload': 'delegate-abc' },
    });
    expect(resource.spec.podTemplate.spec.containers[0]).toMatchObject({
      image: 'example.test/moca-sandbox:v1',
      command: ['sleep', 'infinity'],
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
      volumeMounts: [
        {
          name: 'workspace',
          mountPath: '/workspace',
          subPath: `.context-service/materialized/${revision}`,
          readOnly: true,
        },
      ],
    });
    expect(resource.spec.podTemplate.spec).toMatchObject({
      serviceAccountName: 'serverless-harness-sandbox',
      automountServiceAccountToken: false,
      securityContext: { runAsUser: 65532, runAsNonRoot: true, fsGroup: 65532 },
    });
    expect(resource.spec.podTemplate.spec.volumes[0]).toEqual({
      name: 'workspace',
      persistentVolumeClaim: { claimName: 'context-opaque', readOnly: true },
    });
  });

  it('builds a writable native workspace without Context Service', () => {
    vi.stubEnv('POD_NAMESPACE', 'moca');
    const resource = sandboxResource(
      {
        workloadId: 'native-abc',
        replicas: 1,
        workspace: { kind: 'native', size: '2Gi', storageClass: 'fast' },
      },
      0,
    ) as any;

    expect(resource.spec.volumeClaimTemplates).toEqual([
      {
        metadata: { name: 'workspace' },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '2Gi' } },
          storageClassName: 'fast',
        },
      },
    ]);
    expect(resource.spec.podTemplate.spec.containers[0].volumeMounts).toEqual([
      { name: 'workspace', mountPath: '/workspace' },
    ]);
    expect(resource.spec.podTemplate.spec.volumes).toBeUndefined();
  });

  it('rolls back earlier Sandboxes when replica creation fails', async () => {
    vi.stubEnv('POD_NAMESPACE', 'moca');
    const run = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('create failed'))
      .mockResolvedValueOnce('');

    await expect(
      createWorkloadRuntime(
        {
          workloadId: 'delegate-abc',
          replicas: 2,
          workspace: {
            kind: 'context',
            claimName: 'context-opaque',
            revision: 'a'.repeat(64),
          },
        },
        run,
      ),
    ).rejects.toThrow('create failed');
    expect(run.mock.calls[0][0]).toEqual(['apply', '--filename=/dev/stdin']);
    expect(run.mock.calls[2][0]).toEqual([
      'delete',
      'sandboxes.agents.x-k8s.io',
      'sandbox-delegate-abc-0',
      '-n',
      'moca',
      '--ignore-not-found',
    ]);
  });

  it('reports ready pods and deletes every Sandbox by name', async () => {
    vi.stubEnv('POD_NAMESPACE', 'moca');
    const run = vi.fn().mockResolvedValueOnce(
      JSON.stringify({
        items: [
          { status: { conditions: [{ type: 'Ready', status: 'True' }] } },
          { status: { conditions: [{ type: 'Ready', status: 'False' }] } },
        ],
      }),
    );
    await expect(getWorkloadRuntime('delegate-abc', 2, run)).resolves.toEqual({
      status: 'provisioning',
      readyReplicas: 1,
      sandboxSelector: 'moca.rossoctl.io/workload=delegate-abc',
    });

    run.mockResolvedValueOnce('').mockResolvedValueOnce(JSON.stringify({ items: [] }));
    await deleteWorkloadRuntime('delegate-abc', 2, false, run);
    expect(run.mock.calls[1][0]).toEqual([
      'delete',
      'sandboxes.agents.x-k8s.io',
      'sandbox-delegate-abc-0',
      'sandbox-delegate-abc-1',
      '-n',
      'moca',
      '--ignore-not-found',
    ]);
    expect(run.mock.calls[2][0]).toEqual([
      'get',
      'pods',
      '-n',
      'moca',
      '-l',
      'moca.rossoctl.io/workload=delegate-abc',
      '-o',
      'json',
    ]);
  });

  it('deletes Moca-native workspace claims with their Sandboxes', async () => {
    vi.stubEnv('POD_NAMESPACE', 'moca');
    const run = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(JSON.stringify({ items: [] }))
      .mockResolvedValueOnce('');

    await deleteWorkloadRuntime('native-abc', 2, true, run);

    expect(run.mock.calls[2][0]).toEqual([
      'delete',
      'persistentvolumeclaims',
      'workspace-sandbox-native-abc-0',
      'workspace-sandbox-native-abc-1',
      '-n',
      'moca',
      '--ignore-not-found',
    ]);
  });

  it('waits for workload pods to release Context storage', async () => {
    vi.stubEnv('POD_NAMESPACE', 'moca');
    const run = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(JSON.stringify({ items: [{ metadata: { name: 'terminating' } }] }))
      .mockResolvedValueOnce(JSON.stringify({ items: [] }));

    await deleteWorkloadRuntime('delegate-abc', 1, false, run, { pollIntervalMs: 0 });

    expect(run).toHaveBeenCalledTimes(3);
  });

  it('fails cleanly when workload pods do not terminate', async () => {
    vi.stubEnv('POD_NAMESPACE', 'moca');
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(1);
    const run = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(JSON.stringify({ items: [{ metadata: { name: 'terminating' } }] }));

    await expect(
      deleteWorkloadRuntime('delegate-abc', 1, false, run, { timeoutMs: 0 }),
    ).rejects.toThrow('timed out waiting for workload delegate-abc pods to terminate');
  });
});
