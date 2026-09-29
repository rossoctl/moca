// Manifest-shape test for the RC1-4 OCP AuthBridge overlay (deploy/knative/overlays/ocp-authbridge/).
// This overlay makes the shared RC1 AuthBridge manifests (ibac-stub, AB1, echo-target, AB2,
// sandbox-pool-ab2, the tightened egress policy) deployable on OpenShift under the
// restricted/nonroot SCC, without editing those shared (Kind-gated) manifests. All OCP
// divergence is expressed as image remaps + patches, mirroring deploy/knative/overlays/ocp/.
//
// Pure file parsing (no kustomize binary — CI has none), following the same pattern as
// authbridge-manifests.test.ts and harness-egress-policy.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEPLOY = resolve(REPO_ROOT, 'deploy/knative');
const OVERLAY = resolve(DEPLOY, 'overlays/ocp-authbridge');

function readYaml(path: string): any {
  return parse(readFileSync(path, 'utf8'));
}

/** Parse every YAML document in a (possibly multi-doc) manifest file into plain JS objects. */
function readDocs(path: string): any[] {
  return parseAllDocuments(readFileSync(path, 'utf8')).map((d) => d.toJS());
}

const EXPECTED_RESOURCES = [
  '../../ibac-stub.yaml',
  '../../authbridge/ab1-deployment.yaml',
  '../../echo-target.yaml',
  '../../authbridge/ab2-config.yaml',
  '../../sandbox-pool-ab2.yaml',
  '../../authbridge/harness-egress-ab1.yaml',
];

describe('ocp-authbridge overlay kustomization', () => {
  const kustomization = readYaml(resolve(OVERLAY, 'kustomization.yaml'));

  it('is a valid Kustomization', () => {
    expect(kustomization.apiVersion).toBe('kustomize.config.k8s.io/v1beta1');
    expect(kustomization.kind).toBe('Kustomization');
  });

  it('includes exactly the 6 RC1 AuthBridge resources', () => {
    expect(kustomization.resources).toEqual(EXPECTED_RESOURCES);
  });

  it('is standalone: does not layer on the base ../ocp overlay', () => {
    expect(kustomization.resources).not.toContain('../ocp');
  });

  it('includes the tightened egress policy (harness-egress-ab1.yaml)', () => {
    expect(kustomization.resources).toContain('../../authbridge/harness-egress-ab1.yaml');
  });

  it('remaps all three dev.local images with the exact newName/newTag', () => {
    const images = kustomization.images ?? [];
    expect(images).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'dev.local/moca',
          newName: 'ghcr.io/rossoctl/moca',
          newTag: 'latest',
        }),
        expect.objectContaining({
          name: 'dev.local/echo-target',
          newName: 'ghcr.io/rossoctl/moca-echo-target',
          newTag: 'latest',
        }),
        expect.objectContaining({
          name: 'dev.local/sandbox-rc1',
          newName: 'ghcr.io/rossoctl/moca-sandbox',
          newTag: 'latest',
        }),
      ]),
    );
    expect(images).toHaveLength(3);
  });

  it('does NOT remap the official authbridge image (no remap needed)', () => {
    const images = kustomization.images ?? [];
    const names = images.map((i: any) => i.name);
    expect(names).not.toContain('ghcr.io/rossoctl/kagenti-extensions/authbridge');
  });

  it('wires the Sandbox JSON6902 patch with an explicit target block', () => {
    const patches = kustomization.patches ?? [];
    const sandboxPatch = patches.find((p: any) => p.path === 'patch-sandbox-ab2.yaml');
    expect(sandboxPatch).toBeTruthy();
    expect(sandboxPatch.target).toEqual({
      group: 'agents.x-k8s.io',
      version: 'v1beta1',
      kind: 'Sandbox',
    });
  });

  it('references all four patch files', () => {
    const patches = kustomization.patches ?? [];
    const paths = patches.map((p: any) => p.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'patch-ab1.yaml',
        'patch-ibac-stub.yaml',
        'patch-echo-target.yaml',
        'patch-sandbox-ab2.yaml',
      ]),
    );
  });
});

/** Find a container by name within a pod-spec-shaped containers array. */
function findContainer(containers: any[] | undefined, name: string): any {
  return (containers ?? []).find((c: any) => c?.name === name) ?? {};
}

/** Shared shape assertions for a strategic-merge Deployment SCC patch. */
function assertDeploymentPatchShape(
  patch: any,
  deploymentName: string,
  containerName: string,
  serviceAccountName: string,
) {
  it(`targets the Deployment named ${deploymentName}`, () => {
    expect(patch.kind).toBe('Deployment');
    expect(patch.metadata?.name).toBe(deploymentName);
  });

  it(`sets serviceAccountName to ${serviceAccountName}`, () => {
    expect(patch.spec?.template?.spec?.serviceAccountName).toBe(serviceAccountName);
  });

  it('sets a nonroot pod securityContext with seccompProfile RuntimeDefault', () => {
    const sc = patch.spec?.template?.spec?.securityContext ?? {};
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.seccompProfile?.type).toBe('RuntimeDefault');
  });

  it(`sets a locked-down container securityContext on the ${containerName} container`, () => {
    const containers = patch.spec?.template?.spec?.containers ?? [];
    const container = findContainer(containers, containerName);
    expect(container.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext?.capabilities?.drop).toContain('ALL');
  });
}

describe('patch-ab1.yaml (authbridge-ab1 Deployment patch)', () => {
  const patch = readYaml(resolve(OVERLAY, 'patch-ab1.yaml'));
  assertDeploymentPatchShape(patch, 'authbridge-ab1', 'authbridge-ab1', 'moca');

  it('does NOT pin runAsUser (official image already runs as non-root UID 1001)', () => {
    const sc = patch.spec?.template?.spec?.securityContext ?? {};
    expect(sc.runAsUser).toBeUndefined();
  });
});

describe('patch-ibac-stub.yaml (ibac-stub Deployment patch)', () => {
  const patch = readYaml(resolve(OVERLAY, 'patch-ibac-stub.yaml'));
  assertDeploymentPatchShape(patch, 'ibac-stub', 'ibac-stub', 'moca');

  it('pins runAsUser 65532 (GHCR harness image declares no USER / runs as root)', () => {
    const sc = patch.spec?.template?.spec?.securityContext ?? {};
    expect(sc.runAsUser).toBe(65532);
  });
});

describe('patch-echo-target.yaml (echo-target Deployment patch)', () => {
  const patch = readYaml(resolve(OVERLAY, 'patch-echo-target.yaml'));
  assertDeploymentPatchShape(patch, 'echo-target', 'echo-target', 'moca');

  it('pins runAsUser 1000 (image USER `node` is non-numeric; kubelet needs a numeric UID to verify non-root)', () => {
    const sc = patch.spec?.template?.spec?.securityContext ?? {};
    expect(sc.runAsUser).toBe(1000);
  });
});

describe('patch-sandbox-ab2.yaml (Sandbox CR JSON6902 patch)', () => {
  const ops = readDocs(resolve(OVERLAY, 'patch-sandbox-ab2.yaml'))[0] as any[];

  it('is a JSON6902 op array', () => {
    expect(Array.isArray(ops)).toBe(true);
    expect(ops.length).toBeGreaterThan(0);
  });

  it('adds serviceAccountName = moca-sandbox', () => {
    const op = ops.find((o) => o.path === '/spec/podTemplate/spec/serviceAccountName');
    expect(op).toBeTruthy();
    expect(op.op).toBe('add');
    expect(op.value).toBe('moca-sandbox');
  });

  it('adds a pod securityContext with runAsUser 65532 and fsGroup 65532', () => {
    const op = ops.find((o) => o.path === '/spec/podTemplate/spec/securityContext');
    expect(op).toBeTruthy();
    expect(op.op).toBe('add');
    expect(op.value.runAsUser).toBe(65532);
    expect(op.value.fsGroup).toBe(65532);
    expect(op.value.runAsNonRoot).toBe(true);
    expect(op.value.seccompProfile?.type).toBe('RuntimeDefault');
  });

  it('adds a locked-down container securityContext for BOTH containers/0 and containers/1', () => {
    const op0 = ops.find((o) => o.path === '/spec/podTemplate/spec/containers/0/securityContext');
    const op1 = ops.find((o) => o.path === '/spec/podTemplate/spec/containers/1/securityContext');
    for (const op of [op0, op1]) {
      expect(op).toBeTruthy();
      expect(op.op).toBe('add');
      expect(op.value.allowPrivilegeEscalation).toBe(false);
      expect(op.value.capabilities?.drop).toContain('ALL');
    }
  });

  it('is ADD-ONLY: does not touch image or command (the -ab2 pool sidecar/env must survive)', () => {
    const paths = ops.map((o) => String(o.path));
    expect(paths.some((p) => p.includes('/image'))).toBe(false);
    expect(paths.some((p) => p.includes('/command'))).toBe(false);
    expect(ops.every((o) => o.op === 'add')).toBe(true);
  });
});
