import { describe, expect, it } from 'vitest';
import { NO_KUBECTL, container, find, podSpec, render } from './render.js';

describe.skipIf(NO_KUBECTL)('deploy/k8s base: namespaces, defaults, Redis', () => {
  const objs = () => render('base');

  it('has the three namespaces, all Pod Security restricted', () => {
    for (const ns of ['moca', 'moca-sandbox', 'moca-credentials']) {
      expect(
        find(objs(), 'Namespace', ns).metadata.labels?.['pod-security.kubernetes.io/enforce'],
      ).toBe('restricted');
    }
  });

  it('denies all ingress and egress by default in every namespace', () => {
    for (const ns of ['moca', 'moca-sandbox', 'moca-credentials']) {
      const p = find(objs(), 'NetworkPolicy', 'default-deny', ns);
      expect(p.spec.podSelector).toEqual({});
      expect([...p.spec.policyTypes].sort()).toEqual(['Egress', 'Ingress']);
      expect(p.spec.ingress).toBeUndefined();
      expect(p.spec.egress).toBeUndefined();
    }
  });

  it('runs Redis as a one-replica StatefulSet with a PVC and its config from the Secret', () => {
    const sts = find(objs(), 'StatefulSet', 'redis', 'moca');
    expect(sts.spec.replicas).toBe(1);
    expect(sts.spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe('1Gi');
    const c = container(sts, 'redis');
    expect(c.command).toEqual(['redis-server', '/etc/redis/redis.conf']);
    const cfg = podSpec(sts).volumes.find((v: { name: string }) => v.name === 'config');
    expect(cfg.secret.secretName).toBe('moca-redis');
    expect(cfg.secret.items).toEqual([{ key: 'redis.conf', path: 'redis.conf' }]);
  });

  it('never puts the Redis password on a command line', () => {
    const c = container(find(objs(), 'StatefulSet', 'redis', 'moca'), 'redis');
    const argv = JSON.stringify([c.command, c.args, c.readinessProbe, c.livenessProbe]);
    expect(argv).not.toMatch(/requirepass|-a |REDIS_PASSWORD/);
    // The probes authenticate through REDISCLI_AUTH, which redis-cli reads from its environment.
    expect(c.env).toContainEqual({
      name: 'REDISCLI_AUTH',
      valueFrom: { secretKeyRef: { name: 'moca-redis', key: 'REDIS_PASSWORD' } },
    });
  });

  it('admits Redis traffic only from the supervisor, relay and control plane', () => {
    const p = find(objs(), 'NetworkPolicy', 'redis', 'moca');
    expect(p.spec.podSelector).toEqual({ matchLabels: { app: 'redis' } });
    expect(p.spec.policyTypes).toEqual(['Ingress']);
    const apps = p.spec.ingress[0].from.map(
      (f: { podSelector: { matchLabels: { app: string } } }) => f.podSelector.matchLabels.app,
    );
    expect(apps.sort()).toEqual(['moca-control-plane', 'moca-supervisor', 'sandbox-relay']);
    expect(p.spec.ingress[0].ports).toEqual([{ protocol: 'TCP', port: 6379 }]);
  });

  it('allows DNS to kube-dns from the pods that resolve names, and not from Redis', () => {
    const p = find(objs(), 'NetworkPolicy', 'allow-dns', 'moca');
    expect(p.spec.podSelector.matchExpressions[0].values.sort()).toEqual([
      'moca-control-plane',
      'moca-supervisor',
      'sandbox-relay',
    ]);
    expect(find(objs(), 'NetworkPolicy', 'allow-dns', 'moca-sandbox').spec.podSelector).toEqual({
      matchLabels: { app: 'moca-sandbox' },
    });
  });
});
