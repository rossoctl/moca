import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { K8S_DIR, NO_KUBECTL, container, find, podSpec, render, type K8sObject } from './render.js';

/**
 * The ocp-single Routes component (README §12.5), rendered the way setup.sh's generated overlay
 * lists it: the overlay plus the component, under a namespace transformer. The component itself
 * is what these tests cover; the per-run values (the real domain, the --tls-secret volume patch)
 * are the generated overlay's, covered by the bash tests.
 */
const GHOSTUNNEL =
  'docker.io/ghostunnel/ghostunnel:v1.11.3@sha256:2599b8a04bae16d70a4209495618dea61b46a00a9a05fcf74da282688ad3517f';
const DIR = resolve(K8S_DIR, '.generated/test-ocp-single-routes');
const NS = 'moca-single';

describe.skipIf(NO_KUBECTL)('overlays/ocp-single/routes (README §12.5)', () => {
  let objs: K8sObject[] = [];
  beforeAll(() => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(
      resolve(DIR, 'kustomization.yaml'),
      'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../../overlays/ocp-single\ncomponents:\n  - ../../overlays/ocp-single/routes\nnamespace: moca-single\n',
    );
    const out = execFileSync('kubectl', ['kustomize', DIR], { encoding: 'utf8' });
    objs = parseAllDocuments(out)
      .map((d) => d.toJS() as K8sObject | null)
      .filter((o): o is K8sObject => o !== null);
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));
  const supervisor = () => find(objs, 'Deployment', 'moca-supervisor', NS);

  it('adds the ghostunnel L4 sidecar proxying the supervisor on loopback, with no explicit UID', () => {
    const tls = container(supervisor(), 'tls');
    expect(tls.image).toBe(GHOSTUNNEL);
    expect(tls.args).toEqual([
      'server',
      '--listen',
      '0.0.0.0:8443',
      '--target',
      '127.0.0.1:8080',
      '--cert',
      '/tls/tls.crt',
      '--key',
      '/tls/tls.key',
      '--disable-authentication',
      '--status',
      'http://0.0.0.0:8453',
    ]);
    expect(tls.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
    expect(tls.securityContext.runAsUser).toBeUndefined();
    // #724: probed on its own status port, never on the TLS port (a handshake error every 5 s).
    expect(tls.readinessProbe).toEqual({
      httpGet: { path: '/_metrics', port: 'status' },
      periodSeconds: 5,
    });
    expect(tls.ports).toContainEqual({ name: 'status', containerPort: 8453 });
    const vol = podSpec(supervisor()).volumes.find((v: { name: string }) => v.name === 'tls');
    expect(vol.secret).toEqual({ secretName: 'moca-supervisor-tls', defaultMode: 288 });
    // The supervisor's own container is untouched.
    expect(container(supervisor(), 'supervisor').command).toEqual([
      'node',
      '--import',
      'tsx',
      'src/main.ts',
    ]);
  });

  it('exposes the supervisor by passthrough only, and the control plane by edge', () => {
    const svc = find(objs, 'Service', 'moca-supervisor-tls', NS);
    expect(svc.spec.ports).toEqual([{ name: 'https', port: 8443, targetPort: 'https' }]);
    const r = find(objs, 'Route', 'moca', NS);
    expect(r.spec.tls).toEqual({
      termination: 'passthrough',
      insecureEdgeTerminationPolicy: 'None',
    });
    expect(r.spec.to).toEqual({ kind: 'Service', name: 'moca-supervisor-tls' });
    expect(r.spec.port).toEqual({ targetPort: 'https' });
    const cp = find(objs, 'Route', 'moca-control-plane', NS);
    expect(cp.spec.tls).toEqual({ termination: 'edge', insecureEdgeTerminationPolicy: 'Redirect' });
    expect(cp.spec.to).toEqual({ kind: 'Service', name: 'moca-control-plane' });
    expect(cp.spec.port).toEqual({ targetPort: 'http' });
    // Only the two Routes the component adds.
    expect(objs.filter((o) => o.kind === 'Route').map((o) => o.metadata.name)).toEqual([
      'moca',
      'moca-control-plane',
    ]);
  });

  it('admits only the router namespace, to the sidecar port and the control plane port', () => {
    const sup = find(objs, 'NetworkPolicy', 'moca-supervisor-from-router', NS);
    expect(sup.spec.podSelector).toEqual({ matchLabels: { app: 'moca-supervisor' } });
    expect(sup.spec.policyTypes).toEqual(['Ingress']);
    expect(sup.spec.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: { matchLabels: { 'policy-group.network.openshift.io/ingress': '' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8443 }],
      },
    ]);
    const cp = find(objs, 'NetworkPolicy', 'moca-control-plane-from-router', NS);
    expect(cp.spec.podSelector).toEqual({ matchLabels: { app: 'moca-control-plane' } });
    expect(cp.spec.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: { matchLabels: { 'policy-group.network.openshift.io/ingress': '' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ]);
  });

  it('keeps every ocp-single invariant with the component layered', () => {
    // Still one namespace, still no Namespace object, still no explicit pod-level UID (the
    // sidecar included: restricted-v2 assigns it).
    const namespaces = new Set(
      objs.filter((o) => o.metadata.namespace).map((o) => o.metadata.namespace),
    );
    expect(namespaces).toEqual(new Set([NS]));
    expect(objs.filter((o) => o.kind === 'Namespace')).toEqual([]);
    const sc = podSpec(supervisor()).securityContext;
    expect(sc.runAsUser).toBeUndefined();
    expect(sc.runAsGroup).toBeUndefined();
    expect(sc.fsGroup).toBeUndefined();
  });
});
