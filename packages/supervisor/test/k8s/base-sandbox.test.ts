import { describe, expect, it } from 'vitest';
import { NO_KUBECTL, container, envVar, find, podSpec, render, type K8sObject } from './render.js';

const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']);

describe.skipIf(NO_KUBECTL)('deploy/k8s base: sandboxes and isolation', () => {
  const sts = () => find(render('base'), 'StatefulSet', 'moca-sandbox', 'moca-sandbox');
  const sbx = () => container(sts(), 'sandbox');

  it('gives every sandbox pod its own stable SANDBOX_ID from its pod name', () => {
    expect(envVar(sbx(), 'SANDBOX_ID')).toEqual({
      name: 'SANDBOX_ID',
      valueFrom: { fieldRef: { fieldPath: 'metadata.name' } },
    });
    expect(sts().spec.replicas).toBe(2);
    expect(sts().spec.podManagementPolicy).toBe('Parallel');
    expect(envVar(sbx(), 'RELAY_ADDR')?.value).toBe('sandbox-relay-attach.moca.svc:9443');
  });

  it('holds exactly one secret reference: the attach token', () => {
    expect(envVar(sbx(), 'SANDBOX_TOKEN')).toEqual({
      name: 'SANDBOX_TOKEN',
      valueFrom: { secretKeyRef: { name: 'moca-relay-attach', key: 'SH_RELAY_TOKEN' } },
    });
    const inNs = render('base').filter((o) => o.metadata.namespace === 'moca-sandbox');
    const text = JSON.stringify(inNs);
    for (const forbidden of [
      'MOCA_RELAY_EXEC_TOKEN',
      'moca-redis',
      'moca-mu1',
      'moca-relay"',
      'sandbox-relay-exec',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(inNs.filter((o) => o.kind === 'Secret')).toEqual([]); // setup.sh creates the one Secret, never kustomize
    expect(podSpec(sts()).automountServiceAccountToken).toBe(false);
  });

  it('runs as the image user 1001', () => {
    expect(podSpec(sts()).securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1001 });
  });

  it('admits nothing, and egresses to the relay attach port and the internet minus private ranges', () => {
    const p = find(render('base'), 'NetworkPolicy', 'moca-sandbox', 'moca-sandbox');
    expect(p.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(p.spec.ingress).toBeUndefined();
    expect(p.spec.egress[0]).toEqual({
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'moca' } },
          podSelector: { matchLabels: { app: 'sandbox-relay' } },
        },
      ],
      ports: [{ protocol: 'TCP', port: 9443 }],
    });
    expect(p.spec.egress[1].ports).toBeUndefined(); // all ports: git over 443 and 80, curl anywhere public
    expect(p.spec.egress[1].to[0].ipBlock.cidr).toBe('0.0.0.0/0');
    expect([...p.spec.egress[1].to[0].ipBlock.except].sort()).toEqual(
      ['10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16'].sort(),
    );
  });

  it('puts every pod-bearing namespace under a two-way default deny', () => {
    const objs = render('base');
    const namespaces = new Set(
      objs.filter((o) => WORKLOADS.has(o.kind)).map((o: K8sObject) => o.metadata.namespace),
    );
    for (const ns of namespaces) {
      const deny = find(objs, 'NetworkPolicy', 'default-deny', ns);
      expect([...deny.spec.policyTypes].sort()).toEqual(['Egress', 'Ingress']);
    }
    // ...and every workload has a policy of its own selecting it.
    for (const w of objs.filter((o) => WORKLOADS.has(o.kind))) {
      const app = w.spec.template.metadata.labels.app;
      const own = objs.filter(
        (o) =>
          o.kind === 'NetworkPolicy' &&
          o.metadata.namespace === w.metadata.namespace &&
          o.spec.podSelector?.matchLabels?.app === app,
      );
      expect(own.length, `${w.kind}/${w.metadata.name}`).toBeGreaterThan(0);
    }
  });

  it('runs no Ingress and no Knative object anywhere', () => {
    const objs = render('base');
    expect(objs.filter((o) => o.kind === 'Ingress')).toEqual([]);
    expect(objs.filter((o) => o.apiVersion.startsWith('serving.knative.dev'))).toEqual([]);
  });

  it('never sets SH_EXCHANGE_TOKEN as an env var on any container (it is a file, or the workers refuse to boot)', () => {
    const offenders = render('base')
      .filter((o) => WORKLOADS.has(o.kind))
      .flatMap((o) =>
        (o.spec.template.spec.containers as { name: string; env?: { name: string }[] }[])
          .filter((c) => (c.env ?? []).some((e) => e.name === 'SH_EXCHANGE_TOKEN'))
          .map((c) => `${o.kind}/${o.metadata.name}:${c.name}`),
      );
    expect(offenders).toEqual([]);
  });
});
