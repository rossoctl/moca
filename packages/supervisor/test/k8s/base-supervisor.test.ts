import { describe, expect, it } from 'vitest';
import { NO_KUBECTL, container, envVar, find, podSpec, render, type K8sObject } from './render.js';

const mib = (q: string): number => {
  const m = /^(\d+)(Mi|Gi)$/.exec(q);
  if (!m) throw new Error(`unparsed quantity ${q}`);
  return Number(m[1]) * (m[2] === 'Gi' ? 1024 : 1);
};

describe.skipIf(NO_KUBECTL)('deploy/k8s base: supervisor', () => {
  const dep = () => find(render('base'), 'Deployment', 'moca-supervisor', 'moca');
  const sup = () => container(dep(), 'supervisor');

  it('runs the supervisor from its package dir', () => {
    expect(sup().workingDir).toBe('/app/packages/supervisor');
    expect(sup().command).toEqual(['node', '--import', 'tsx', 'src/main.ts']);
  });

  it('keeps the fork constraint: no other workload runs the supervisor or a turn worker', () => {
    // fork() cannot cross containers (ADR-0034): the pool lives in this one container.
    const runsP6 = (o: K8sObject) =>
      (o.spec?.template?.spec?.containers ?? []).some(
        (c: { workingDir?: string; command?: string[] }) =>
          c.workingDir === '/app/packages/supervisor' ||
          (c.command ?? []).join(' ').includes('src/worker.ts'),
      );
    const owners = render('base')
      .filter(runsP6)
      .map((o) => `${o.kind}/${o.metadata.name}`);
    expect(owners).toEqual(['Deployment/moca-supervisor']);
    expect(
      podSpec(dep()).containers.filter(
        (c: { workingDir?: string }) => c.workingDir === '/app/packages/supervisor',
      ),
    ).toHaveLength(1);
  });

  it('pins W and sizes memory for it: at least W x 256Mi', () => {
    const w = Number(envVar(sup(), 'SH_WORKERS')?.value);
    expect(w).toBe(2);
    expect(sup().resources.limits.cpu).toBe('2');
    expect(mib(sup().resources.requests.memory)).toBeGreaterThanOrEqual(w * 256);
    expect(mib(sup().resources.limits.memory)).toBeGreaterThanOrEqual(
      mib(sup().resources.requests.memory),
    );
  });

  it('drains like the systemd unit: 120s grace, a preStop pause, no unavailable pod in a rollout', () => {
    expect(podSpec(dep()).terminationGracePeriodSeconds).toBeGreaterThanOrEqual(120);
    expect(sup().lifecycle.preStop.exec.command).toEqual(['sleep', '5']);
    expect(dep().spec.strategy.rollingUpdate.maxUnavailable).toBe(0);
  });

  it('probes the admin listener, which it binds on the pod IP', () => {
    expect(envVar(sup(), 'SH_ADMIN_HOST')?.value).toBe('0.0.0.0');
    expect(sup().readinessProbe.httpGet).toEqual({ path: '/readyz', port: 'admin' });
    expect(sup().livenessProbe.httpGet).toEqual({ path: '/healthz', port: 'admin' });
    const s = sup().startupProbe;
    expect(s.httpGet).toEqual({ path: '/readyz', port: 'admin' });
    expect(s.periodSeconds * s.failureThreshold).toBeGreaterThanOrEqual(120);
  });

  it('reads the exchange token from a file, never from env', () => {
    expect(envVar(sup(), 'SH_EXCHANGE_TOKEN')).toBeUndefined();
    expect(envVar(sup(), 'CREDENTIALS_DIRECTORY')?.value).toBe('/run/credentials');
    const vol = podSpec(dep()).volumes.find((v: { name: string }) => v.name === 'credentials');
    // items: ONLY the exchange token is projected; the private key and KEK never enter this pod.
    expect(vol.secret).toEqual({
      secretName: 'moca-mu1',
      items: [{ key: 'SH_EXCHANGE_TOKEN', path: 'SH_EXCHANGE_TOKEN' }],
      defaultMode: 256,
    });
    expect(sup().volumeMounts).toContainEqual({
      name: 'credentials',
      mountPath: '/run/credentials',
      readOnly: true,
    });
  });

  it('dials the relay EXEC Service and requires session tokens', () => {
    expect(envVar(sup(), 'SH_RELAY_ADDR')?.value).toBe('sandbox-relay-exec.moca.svc:9444');
    expect(envVar(sup(), 'SH_REQUIRE_AUTH')?.value).toBe('true');
    expect(envVar(sup(), 'SH_CONTROL_PLANE_URL')?.value).toBe(
      'http://moca-control-plane.moca.svc:8080',
    );
    expect(envVar(sup(), 'MOCA_RELAY_EXEC_TOKEN')).toEqual({
      name: 'MOCA_RELAY_EXEC_TOKEN',
      valueFrom: { secretKeyRef: { name: 'moca-relay', key: 'MOCA_RELAY_EXEC_TOKEN' } },
    });
  });

  it('admits nothing to the data port from the pod network, and the admin port from its own namespace only', () => {
    const p = find(render('base'), 'NetworkPolicy', 'moca-supervisor', 'moca');
    const ports = p.spec.ingress.flatMap((r: { ports: { port: number }[] }) =>
      r.ports.map((x) => x.port),
    );
    expect(ports).toEqual([8081]);
    expect(p.spec.ingress[0].from).toEqual([{ podSelector: {} }]);
  });

  it('egresses only to Redis, the relay exec port, the control plane and 443', () => {
    const p = find(render('base'), 'NetworkPolicy', 'moca-supervisor', 'moca');
    const rules = p.spec.egress.map((r: { to: unknown[]; ports: { port: number }[] }) => [
      r.to,
      r.ports.map((x) => x.port),
    ]);
    expect(rules).toEqual([
      [[{ podSelector: { matchLabels: { app: 'redis' } } }], [6379]],
      [[{ podSelector: { matchLabels: { app: 'sandbox-relay' } } }], [9444]],
      [[{ podSelector: { matchLabels: { app: 'moca-control-plane' } } }], [8080]],
      [[{ ipBlock: { cidr: '0.0.0.0/0' } }], [443]],
    ]);
  });
});
