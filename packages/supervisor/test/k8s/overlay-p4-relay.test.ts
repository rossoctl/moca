import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { K8S_DIR, NO_KUBECTL, container, find, podSpec, render, type K8sObject } from './render.js';

const GHOSTUNNEL =
  'docker.io/ghostunnel/ghostunnel:v1.11.3@sha256:2599b8a04bae16d70a4209495618dea61b46a00a9a05fcf74da282688ad3517f';
// A kustomization at the generated overlay's depth that lists the component, as setup.sh's will.
const DIR = resolve(K8S_DIR, '.generated/test-p4-relay');

describe.skipIf(NO_KUBECTL)('overlays/ocp/p4-relay (P6.2 §2.4)', () => {
  let objs: K8sObject[] = [];
  beforeAll(() => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(
      resolve(DIR, 'kustomization.yaml'),
      'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../../overlays/ocp\ncomponents:\n  - ../../overlays/ocp/p4-relay\n',
    );
    const out = execFileSync('kubectl', ['kustomize', DIR], { encoding: 'utf8' });
    objs = parseAllDocuments(out)
      .map((d) => d.toJS() as K8sObject | null)
      .filter((o): o is K8sObject => o !== null);
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));
  const relay = () => find(objs, 'Deployment', 'sandbox-relay', 'moca');

  it('adds an L4 TLS sidecar that proxies to the attach listener on loopback', () => {
    const tls = container(relay(), 'tls');
    expect(tls.image).toBe(GHOSTUNNEL);
    expect(tls.args).toEqual([
      'server',
      '--listen',
      '0.0.0.0:8444',
      '--target',
      '127.0.0.1:9443',
      '--cert',
      '/tls/tls.crt',
      '--key',
      '/tls/tls.key',
      '--disable-authentication',
      '--alpn',
      'h2',
      '--status',
      'http://0.0.0.0:8454',
    ]);
    expect(tls.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
    // #724: probed on its own status port, never on the TLS port (a handshake error every 5 s).
    expect(tls.readinessProbe).toEqual({
      httpGet: { path: '/_metrics', port: 'status' },
      periodSeconds: 5,
    });
    expect(tls.ports).toContainEqual({ name: 'status', containerPort: 8454 });
    const vol = podSpec(relay()).volumes.find((v: { name: string }) => v.name === 'relay-tls');
    expect(vol.secret).toEqual({ secretName: 'moca-relay-tls', defaultMode: 288 });
    // The relay itself is untouched: still one replica, Recreate, its own container intact.
    expect(relay().spec.strategy).toEqual({ type: 'Recreate' });
    // The sidecar is listed first, so plain `kubectl logs`/`exec` must be pointed at the relay.
    expect(
      relay().spec.template.metadata.annotations?.['kubectl.kubernetes.io/default-container'],
    ).toBe('sandbox-relay');
    expect(container(relay(), 'sandbox-relay').command).toEqual([
      'node',
      '--import',
      'tsx',
      'src/main.ts',
    ]);
  });

  it('exposes only the sidecar, by passthrough, with an idle timeout above the 30 s keepalive', () => {
    const svc = find(objs, 'Service', 'sandbox-relay-tls', 'moca');
    expect(svc.spec.ports).toEqual([{ name: 'https', port: 8444, targetPort: 'https' }]);
    const r = find(objs, 'Route', 'moca-relay', 'moca');
    expect(r.spec.tls).toEqual({
      termination: 'passthrough',
      insecureEdgeTerminationPolicy: 'None',
    });
    expect(r.spec.to).toEqual({ kind: 'Service', name: 'sandbox-relay-tls' });
    expect(r.spec.port).toEqual({ targetPort: 'https' });
    expect(r.metadata.annotations?.['haproxy.router.openshift.io/timeout']).toBe('5m');
    // Nothing routes to the exec Service.
    expect(
      objs.filter((o) => o.kind === 'Route' && o.spec.to.name === 'sandbox-relay-exec'),
    ).toEqual([]);
  });

  it('admits the router to 8444 only, additively', () => {
    const p = find(objs, 'NetworkPolicy', 'sandbox-relay-from-router', 'moca');
    expect(p.spec.podSelector).toEqual({ matchLabels: { app: 'sandbox-relay' } });
    expect(p.spec.policyTypes).toEqual(['Ingress']);
    expect(p.spec.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: { matchLabels: { 'policy-group.network.openshift.io/ingress': '' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8444 }],
      },
    ]);
    // The base relay policy is unchanged: still nothing on 8444 there, exec still supervisor-only.
    const base = find(objs, 'NetworkPolicy', 'sandbox-relay', 'moca');
    const ports = base.spec.ingress.flatMap((r: { ports: { port: number }[] }) =>
      r.ports.map((x) => x.port),
    );
    expect(ports.sort()).toEqual([9443, 9444]);
  });

  it('is absent from the plain ocp overlay (no P4 host means slice 1 exactly)', () => {
    const plain = render('overlays/ocp');
    expect(
      plain.find((o) => o.kind === 'Route' && o.metadata.name === 'moca-relay'),
    ).toBeUndefined();
    expect(
      podSpec(find(plain, 'Deployment', 'sandbox-relay', 'moca')).containers.map(
        (c: { name: string }) => c.name,
      ),
    ).toEqual(['sandbox-relay']);
  });
});
