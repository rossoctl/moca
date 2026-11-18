import type { Kind, KubeApi, KubeObject } from '../src/kube.js';

/**
 * An in-memory namespace with the API's observable rules: create of an existing name is a
 * conflict, delete of a missing one is "already gone", a JSON merge patch merges, and a selector is
 * `k=v[,k=v]`. A created object is stamped with `creationTimestamp` from `clock`, and a replace
 * keeps it. Deleting a StatefulSet leaves its pods until `reapPods()`, as the garbage
 * collector does. Reading a Secret is forbidden, as the provisioner's Role makes it. Every call
 * yields first, so concurrent callers interleave as they would against a real API server.
 */
export class FakeKube implements KubeApi {
  objects: Record<Kind, Map<string, KubeObject>> = {
    secrets: new Map(),
    services: new Map(),
    statefulsets: new Map(),
    pods: new Map(),
    podtemplates: new Map(),
    persistentvolumeclaims: new Map(),
  };
  calls: string[] = [];
  /** The API server's clock, in ms: what a created object's creationTimestamp is stamped from. */
  clock: () => number = () => Date.now();
  private rv = 1;

  private clone<T>(o: T): T {
    return JSON.parse(JSON.stringify(o)) as T;
  }

  private async enter(call: string, kind: Kind, read = false): Promise<void> {
    this.calls.push(call);
    await new Promise((r) => setImmediate(r));
    if (read && kind === 'secrets') throw new Error(`forbidden: ${call}`);
  }

  async get(kind: Kind, name: string): Promise<KubeObject | null> {
    await this.enter(`get ${kind} ${name}`, kind, true);
    const o = this.objects[kind].get(name);
    return o ? this.clone(o) : null;
  }

  async list(kind: Kind, labelSelector: string): Promise<KubeObject[]> {
    await this.enter(`list ${kind} ${labelSelector}`, kind, true);
    const want = labelSelector.split(',').map((p) => p.split('=') as [string, string]);
    return [...this.objects[kind].values()]
      .filter((o) => want.every(([k, v]) => o.metadata.labels?.[k] === v))
      .map((o) => this.clone(o));
  }

  async create(kind: Kind, obj: KubeObject): Promise<boolean> {
    await this.enter(`create ${kind} ${obj.metadata.name}`, kind);
    if (this.objects[kind].has(obj.metadata.name)) return false;
    const stored = this.clone(obj);
    stored.metadata.resourceVersion = String(this.rv++);
    stored.metadata.creationTimestamp = new Date(this.clock()).toISOString();
    this.objects[kind].set(obj.metadata.name, stored);
    return true;
  }

  async replace(kind: Kind, obj: KubeObject): Promise<void> {
    await this.enter(`replace ${kind} ${obj.metadata.name}`, kind);
    const cur = this.objects[kind].get(obj.metadata.name);
    if (!cur) throw new Error(`replace of missing ${kind} ${obj.metadata.name}`);
    const stored = this.clone(obj);
    stored.metadata.resourceVersion = String(this.rv++);
    stored.metadata.creationTimestamp = cur.metadata.creationTimestamp;
    this.objects[kind].set(obj.metadata.name, stored);
  }

  async patch(kind: Kind, name: string, patch: object): Promise<void> {
    await this.enter(`patch ${kind} ${name}`, kind);
    const cur = this.objects[kind].get(name);
    if (!cur) throw new Error(`patch of missing ${kind} ${name}`);
    const merge = (a: Record<string, unknown>, b: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(b)) {
        // A merge patch never names these; skipping them keeps the fake from polluting prototypes.
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') {
          merge(a[k] as Record<string, unknown>, v as Record<string, unknown>);
        } else a[k] = v;
      }
    };
    merge(cur as Record<string, unknown>, this.clone(patch) as Record<string, unknown>);
  }

  async delete(kind: Kind, name: string): Promise<boolean> {
    await this.enter(`delete ${kind} ${name}`, kind);
    return this.objects[kind].delete(name);
  }

  /** What a StatefulSet controller would do: one pod per replica, labelled from the template. */
  runPods(stsName: string): void {
    const sts = this.objects.statefulsets.get(stsName)!;
    for (let i = 0; i < sts.spec.replicas; i++) {
      const name = `${stsName}-${i}`;
      this.objects.pods.set(name, {
        metadata: { name, labels: { ...sts.spec.template.metadata.labels } },
      });
    }
    sts.status = { readyReplicas: sts.spec.replicas };
  }

  /** The garbage collector: pods whose StatefulSet is gone are removed. */
  reapPods(): void {
    for (const [name, pod] of this.objects.pods) {
      const owner = name.replace(/-[0-9]+$/, '');
      if (!this.objects.statefulsets.has(owner) && pod.metadata.labels?.['moca.dev/workload']) {
        this.objects.pods.delete(name);
      }
    }
  }
}

/** The PodTemplate moca-workload-sandbox, as workload-sandboxes/template.yaml renders it on kind. */
export function workloadTemplate(): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'PodTemplate',
    metadata: { name: 'moca-workload-sandbox', namespace: 'moca-sandbox' },
    template: {
      metadata: {
        labels: { app: 'moca-workload-sandbox' },
        annotations: { 'moca.dev/image-id': 'x' },
      },
      spec: {
        serviceAccountName: 'moca-workload-sandbox',
        automountServiceAccountToken: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1001,
          runAsGroup: 0,
          fsGroup: 0,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name: 'sandbox',
            image: 'dev.local/moca-remote-worker:local',
            env: [
              { name: 'RELAY_ADDR', value: 'sandbox-relay-attach.moca.svc:9443' },
              {
                name: 'SH_WORKSPACE_IDLE',
                valueFrom: {
                  configMapKeyRef: {
                    name: 'moca-sandbox-settings',
                    key: 'SH_WORKSPACE_IDLE',
                    optional: true,
                  },
                },
              },
              // An operator's value for a binding variable is replaced, never kept.
              { name: 'SANDBOX_TIER', value: 'microvm' },
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
              readOnlyRootFilesystem: false,
            },
            resources: { requests: { cpu: '10m', memory: '64Mi' }, limits: { memory: '512Mi' } },
            volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
          },
        ],
        volumes: [{ name: 'workspace', emptyDir: {} }],
      },
    },
  };
}
