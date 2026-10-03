import { describe, expect, it } from 'vitest';
import { NO_KUBECTL, container, envVar, find, podSpec, render } from './render.js';

describe.skipIf(NO_KUBECTL)('deploy/k8s base: control plane', () => {
  const dep = () => find(render('base'), 'Deployment', 'moca-control-plane', 'moca');
  const cp = () => container(dep(), 'control-plane');

  it('uses the Kubernetes credential store in its own namespace, explicitly', () => {
    expect(envVar(cp(), 'SH_CREDENTIAL_STORE')?.value).toBe('kubernetes');
    expect(envVar(cp(), 'SH_CREDENTIAL_NAMESPACE')?.value).toBe('moca-credentials');
  });

  it('may touch Secrets in moca-credentials, without list, and nothing about pods', () => {
    const role = find(render('base'), 'Role', 'moca-control-plane-credentials', 'moca-credentials');
    expect(role.rules).toEqual([
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get', 'create', 'update', 'patch', 'delete'],
      },
    ]);
    const rb = find(
      render('base'),
      'RoleBinding',
      'moca-control-plane-credentials',
      'moca-credentials',
    );
    expect(rb.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'moca-control-plane', namespace: 'moca' },
    ]);
    // The pod-exec path's sh-control-plane-pods Role is not needed: a relay-attached harness never
    // reports sandboxPod/sandboxSelector, and its absence fails soft (resources.ts).
    const podRules = render('base')
      .filter((o) => o.kind === 'Role' || o.kind === 'ClusterRole')
      .flatMap((o) => o.rules ?? [])
      .filter((r: { resources: string[] }) => r.resources.includes('pods'));
    expect(podRules).toEqual([]);
  });

  it('mounts its three secrets as files and reads settings from the ConfigMap', () => {
    for (const k of ['SH_SESSION_TOKEN_PRIVATE_KEY', 'SH_CREDENTIAL_KEK', 'SH_EXCHANGE_TOKEN']) {
      expect(envVar(cp(), k)).toBeUndefined();
    }
    expect(envVar(cp(), 'CREDENTIALS_DIRECTORY')?.value).toBe('/run/credentials');
    const vol = podSpec(dep()).volumes.find((v: { name: string }) => v.name === 'credentials');
    expect(vol.secret.secretName).toBe('moca-mu1');
    expect(vol.secret.items.map((i: { key: string }) => i.key).sort()).toEqual([
      'SH_CREDENTIAL_KEK',
      'SH_EXCHANGE_TOKEN',
      'SH_SESSION_TOKEN_PRIVATE_KEY',
    ]);
    for (const k of [
      'SH_GITHUB_CLIENT_ID',
      'SH_ADMIN_SUBJECTS',
      'SH_PUBLIC_HARNESS_URL',
      'SH_ALLOW_OPERATOR_FALLBACK',
    ]) {
      expect(envVar(cp(), k)).toEqual({
        name: k,
        valueFrom: { configMapKeyRef: { name: 'moca-settings', key: k } },
      });
    }
  });

  it('keeps the existing probes and needs its ServiceAccount token for the kube API', () => {
    expect(cp().readinessProbe.httpGet).toEqual({ path: '/readyz', port: 'http' });
    expect(cp().livenessProbe.httpGet).toEqual({ path: '/healthz', port: 'http' });
    expect(podSpec(dep()).automountServiceAccountToken).toBe(true);
  });

  it('admits the supervisor, and egresses to Redis and the kube API / GitHub only', () => {
    const p = find(render('base'), 'NetworkPolicy', 'moca-control-plane', 'moca');
    expect(p.spec.ingress).toEqual([
      {
        from: [{ podSelector: { matchLabels: { app: 'moca-supervisor' } } }],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ]);
    expect(p.spec.egress).toEqual([
      {
        to: [{ podSelector: { matchLabels: { app: 'redis' } } }],
        ports: [{ protocol: 'TCP', port: 6379 }],
      },
      {
        to: [{ ipBlock: { cidr: '0.0.0.0/0' } }],
        ports: [
          { protocol: 'TCP', port: 443 },
          { protocol: 'TCP', port: 6443 },
        ],
      },
    ]);
  });
});
