// Manifest-shape tests for the dedicated `swebench` sandbox pool (Plan B / Task 4a). This pool is
// OCP-only: it runs the Task-3 baked x86_64 image (15 conda envs + 8 bare repo mirrors) from the
// OCP internal registry, separate from the default pool, so Plan C's `WORKLOAD=swebench` provider
// can select it via `KAGENTI_SANDBOX_POOL_SELECTOR=sh.kagenti.io/sandbox-pool=swebench`. This is
// pure file parsing: no cluster, no kustomize binary, runs in the existing `pnpm -r test` CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEPLOY = resolve(REPO_ROOT, 'deploy/knative');

/** Parse every YAML document in a (possibly multi-doc) manifest file into plain JS objects. */
function readDocs(path: string): any[] {
  return parseAllDocuments(readFileSync(path, 'utf8')).map((d) => d.toJS());
}

const SWEBENCH_IMAGE =
  'image-registry.openshift-image-registry.svc:5000/default/swebench-sandbox:ff962cb83fe5c624-15of15';

describe('swebench-sandbox-pool manifest', () => {
  const SWEBENCH_POOL_PATH = resolve(DEPLOY, 'swebench-sandbox-pool.yaml');
  const docs = readDocs(SWEBENCH_POOL_PATH);
  const sandboxes = docs.filter((d) => d?.kind === 'Sandbox');

  it('defines exactly 3 Sandbox CRs named swebench-sandbox-0/1/2, all in namespace default', () => {
    expect(sandboxes).toHaveLength(3);
    expect(sandboxes.map((s) => s.apiVersion)).toEqual([
      'agents.x-k8s.io/v1beta1',
      'agents.x-k8s.io/v1beta1',
      'agents.x-k8s.io/v1beta1',
    ]);
    expect(sandboxes.map((s) => s.metadata?.name)).toEqual([
      'swebench-sandbox-0',
      'swebench-sandbox-1',
      'swebench-sandbox-2',
    ]);
    for (const s of sandboxes) {
      expect(s.metadata?.namespace).toBe('default');
    }
  });

  it.each(sandboxes.map((s, i) => [i, s]))(
    'sandbox %s: carries the CR-level app=sandbox label',
    (_i, sandbox: any) => {
      expect(sandbox.metadata?.labels?.app).toBe('sandbox');
    },
  );

  it.each(sandboxes.map((s, i) => [i, s]))(
    'sandbox %s: podTemplate pool-discovery label is exactly swebench (not default)',
    (_i, sandbox: any) => {
      const poolLabel = sandbox.spec?.podTemplate?.metadata?.labels?.['sh.kagenti.io/sandbox-pool'];
      expect(poolLabel).toBe('swebench');
      expect(poolLabel).not.toBe('default');
    },
  );

  it.each(sandboxes.map((s, i) => [i, s]))(
    'sandbox %s: container uses the Task-3 baked internal-registry image',
    (_i, sandbox: any) => {
      const containers = sandbox.spec?.podTemplate?.spec?.containers ?? [];
      expect(containers[0]?.image).toBe(SWEBENCH_IMAGE);
      expect(containers[0]?.imagePullPolicy).toBe('IfNotPresent');
    },
  );

  it.each(sandboxes.map((s, i) => [i, s]))(
    'sandbox %s: container command is exactly sleep infinity (no apk/startup install)',
    (_i, sandbox: any) => {
      const containers = sandbox.spec?.podTemplate?.spec?.containers ?? [];
      expect(containers[0]?.command).toEqual(['sleep', 'infinity']);
    },
  );

  it.each(sandboxes.map((s, i) => [i, s]))(
    'sandbox %s: container workingDir and workspace volumeMount are /workspace',
    (_i, sandbox: any) => {
      const containers = sandbox.spec?.podTemplate?.spec?.containers ?? [];
      const container = containers[0] ?? {};
      expect(container.workingDir).toBe('/workspace');
      const workspaceMount = (container.volumeMounts ?? []).find(
        (m: any) => m.name === 'workspace',
      );
      expect(workspaceMount?.mountPath).toBe('/workspace');
    },
  );

  it.each(sandboxes.map((s, i) => [i, s]))(
    'sandbox %s: volumeClaimTemplate requests a 50Gi RWO PVC named workspace',
    (_i, sandbox: any) => {
      const vct = (sandbox.spec?.volumeClaimTemplates ?? [])[0] ?? {};
      expect(vct.metadata?.name).toBe('workspace');
      expect(vct.spec?.accessModes).toEqual(['ReadWriteOnce']);
      expect(vct.spec?.resources?.requests?.storage).toBe('50Gi');
    },
  );

  it.each(sandboxes.map((s, i) => [i, s]))(
    'sandbox %s: podTemplate uses the moca-sandbox SA',
    (_i, sandbox: any) => {
      expect(sandbox.spec?.podTemplate?.spec?.serviceAccountName).toBe('moca-sandbox');
    },
  );

  it.each(sandboxes.map((s, i) => [i, s]))(
    'sandbox %s: pod-level securityContext is OCP nonroot',
    (_i, sandbox: any) => {
      const podSecurityContext = sandbox.spec?.podTemplate?.spec?.securityContext ?? {};
      expect(podSecurityContext.runAsUser).toBe(65532);
      expect(podSecurityContext.runAsNonRoot).toBe(true);
      expect(podSecurityContext.fsGroup).toBe(65532);
      expect(podSecurityContext.seccompProfile?.type).toBe('RuntimeDefault');
    },
  );

  it.each(sandboxes.map((s, i) => [i, s]))(
    'sandbox %s: container-level securityContext drops all capabilities',
    (_i, sandbox: any) => {
      const containers = sandbox.spec?.podTemplate?.spec?.containers ?? [];
      const containerSecurityContext = containers[0]?.securityContext ?? {};
      expect(containerSecurityContext.allowPrivilegeEscalation).toBe(false);
      expect(containerSecurityContext.capabilities?.drop).toContain('ALL');
    },
  );
});
