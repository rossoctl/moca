import { describe, expect, it } from 'vitest';
import { NO_KUBECTL, container, find, podSpec, render } from './render.js';

describe.skipIf(NO_KUBECTL)('deploy/k8s overlays/ocp', () => {
  const objs = () => render('overlays/ocp');
  const dep = () => find(objs(), 'Deployment', 'moca-supervisor', 'moca');

  it('fronts the supervisor with an L4 TLS sidecar that proxies to loopback 8080', () => {
    const tls = container(dep(), 'tls');
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
    ]);
    expect(tls.image).toMatch(/^docker\.io\/ghostunnel\/ghostunnel(:[^@]+)?@sha256:[0-9a-f]{64}$/);
    const vol = podSpec(dep()).volumes.find((v: { name: string }) => v.name === 'tls');
    expect(vol.secret.secretName).toBe('moca-supervisor-tls');
  });

  it('hardens the TLS sidecar with proper security context and pod-level UID', () => {
    const tls = container(dep(), 'tls');
    expect(tls.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
    expect(podSpec(dep()).securityContext.runAsUser).toBe(65532);
  });

  it('routes the supervisor by TLS passthrough to the sidecar, never by an L7 hop', () => {
    const r = find(objs(), 'Route', 'moca', 'moca');
    expect(r.spec.tls.termination).toBe('passthrough');
    expect(r.spec.to).toEqual({ kind: 'Service', name: 'moca-supervisor-tls' });
    expect(r.spec.port).toEqual({ targetPort: 'https' });
    const svc = find(objs(), 'Service', 'moca-supervisor-tls', 'moca');
    expect(svc.spec.ports).toEqual([{ name: 'https', port: 8443, targetPort: 'https' }]);
    // Nothing may route to the plain data port.
    const toPlain = objs().filter(
      (o) => o.kind === 'Route' && o.spec.to.name === 'moca-supervisor',
    );
    expect(toPlain).toEqual([]);
    expect(objs().filter((o) => o.kind === 'Ingress')).toEqual([]);
  });

  it('gives the control plane an ordinary edge Route', () => {
    const r = find(objs(), 'Route', 'moca-control-plane', 'moca');
    expect(r.spec.tls.termination).toBe('edge');
    expect(r.spec.to).toEqual({ kind: 'Service', name: 'moca-control-plane' });
  });

  it('admits the router to 8443 and the control plane, and adds openshift-dns, all additively', () => {
    const router = {
      namespaceSelector: { matchLabels: { 'policy-group.network.openshift.io/ingress': '' } },
    };
    const sup = find(objs(), 'NetworkPolicy', 'moca-supervisor-from-router', 'moca');
    expect(sup.spec.ingress).toEqual([
      { from: [router], ports: [{ protocol: 'TCP', port: 8443 }] },
    ]);
    const cp = find(objs(), 'NetworkPolicy', 'moca-control-plane-from-router', 'moca');
    expect(cp.spec.ingress).toEqual([{ from: [router], ports: [{ protocol: 'TCP', port: 8080 }] }]);
    for (const ns of ['moca', 'moca-sandbox']) {
      const dns = find(objs(), 'NetworkPolicy', 'allow-openshift-dns', ns);
      expect(dns.spec.egress[0].ports).toEqual([
        { protocol: 'UDP', port: 5353 },
        { protocol: 'TCP', port: 5353 },
      ]);
    }
    // The base policy is untouched: still no rule for 8080 on the supervisor.
    const base = find(objs(), 'NetworkPolicy', 'moca-supervisor', 'moca');
    expect(
      base.spec.ingress.flatMap((r: { ports: { port: number }[] }) => r.ports.map((p) => p.port)),
    ).toEqual([8081]);
  });

  it('keeps the TLS Secret out of the sandbox namespace', () => {
    const inSbx = JSON.stringify(objs().filter((o) => o.metadata.namespace === 'moca-sandbox'));
    expect(inSbx).not.toContain('moca-supervisor-tls');
  });
});
