import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import {
  K8S_DIR,
  NO_KUBECTL,
  container,
  envNames,
  envVar,
  find,
  podSpec,
  render,
  type K8sObject,
  type Target,
} from './render.js';

// moca-provisioner (workload sandboxes spec §4, ADR-0043): off by default, and with the
// workload-sandboxes component its RBAC, its reach, its admission policy and the pod template.

const TARGETS: Target[] = [
  'base',
  'overlays/kind',
  'overlays/kind-ci',
  'overlays/ocp',
  'overlays/ocp-single',
  'overlays/ocp-sbx',
];
const FEATURE_NAMES = ['moca-provisioner', 'moca-workload-sandbox', 'workload-sandbox'];

describe.skipIf(NO_KUBECTL)('deploy/k8s without SH_WORKLOAD_SANDBOXES', () => {
  it.each(TARGETS)('%s renders no provisioner object, quota or admission policy', (target) => {
    const objs = render(target);
    const named = objs.filter((o) => FEATURE_NAMES.some((n) => o.metadata.name.includes(n)));
    expect(named).toEqual([]);
    expect(
      objs.filter((o) =>
        ['ResourceQuota', 'PodTemplate', 'ValidatingAdmissionPolicy'].includes(o.kind),
      ),
    ).toEqual([]);
    expect(JSON.stringify(objs)).not.toMatch(/moca-provisioner|moca-workload-sandbox|MOCA_ATTACH/);
  });
});

const WRITER = fileURLToPath(new URL('./fixtures/write-generated-overlay.sh', import.meta.url));
/** What setup.sh's kube_api_egress builds on Kind: the Service's ClusterIP and the endpoint. */
const KUBE_API_EGRESS = [
  { to: [{ ipBlock: { cidr: '10.96.0.1/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
  { to: [{ ipBlock: { cidr: '172.18.0.2/32' } }], ports: [{ protocol: 'TCP', port: 6443 }] },
];

/** ensure_redis_secret's REDIS_ACL_HASH: the sha256 of the provisioner's redis.conf line. */
const REDIS_ACL_HASH = 'a'.repeat(64);

/** setup.sh's own write_overlay with SH_WORKLOAD_SANDBOXES=1, rendered through kubectl kustomize. */
function renderGenerated(dir: string, env: Record<string, string>): K8sObject[] {
  execFileSync('bash', [WRITER, dir], {
    env: {
      ...process.env,
      GO_SANDBOX_COUNT: '2',
      GO_CLIENT_ID: 'Iv1.provisioner-test',
      GO_SETTINGS_HASH: 'f'.repeat(64),
      GO_WORKLOAD_SANDBOXES: '1',
      GO_KUBE_API_EGRESS: JSON.stringify(KUBE_API_EGRESS),
      GO_WORKLOAD_CLASSES: 'standard:rwo nfs:rwx',
      GO_OTHER_CLASSES: 'slow',
      GO_REDIS_ACL_HASH: REDIS_ACL_HASH,
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const out = execFileSync('kubectl', ['kustomize', dir], { encoding: 'utf8' });
  return parseAllDocuments(out)
    .map((d) => d.toJS() as K8sObject | null)
    .filter((o): o is K8sObject => o !== null);
}

const KIND_DIR = resolve(K8S_DIR, '.generated/test-workload-sandboxes-kind');
const OCP_DIR = resolve(K8S_DIR, '.generated/test-workload-sandboxes-ocp');

describe.skipIf(NO_KUBECTL)('deploy/k8s workload-sandboxes component (setup.sh overlay)', () => {
  let objs: K8sObject[] = [];
  let ocp: K8sObject[] = [];
  beforeAll(() => {
    objs = renderGenerated(KIND_DIR, {
      GO_TARGET: 'kind',
      GO_HARNESS_IMAGE_ID: 'sha256:harness',
      GO_SANDBOX_IMAGE_ID: 'sha256:sandbox',
      GO_EGRESS_EXCEPT: '203.0.113.0/24',
    });
    ocp = renderGenerated(OCP_DIR, {
      GO_TARGET: 'ocp',
      GO_IMAGE: 'ghcr.io/me/moca:v1',
      GO_SANDBOX_IMAGE: 'quay.io/me/rw:v2',
      GO_SUP_HOST: 'moca.apps.example.test',
      GO_CP_HOST: 'cp.apps.example.test',
    });
  });
  afterAll(() => {
    rmSync(KIND_DIR, { recursive: true, force: true });
    rmSync(OCP_DIR, { recursive: true, force: true });
  });

  it("binds spec §4.1's Role, with no read on Secrets, in moca-sandbox only", () => {
    const role = find(objs, 'Role', 'moca-provisioner', 'moca-sandbox');
    expect(role.rules).toEqual([
      {
        apiGroups: ['apps'],
        resources: ['statefulsets'],
        verbs: ['create', 'get', 'list', 'patch', 'delete'],
      },
      { apiGroups: [''], resources: ['secrets'], verbs: ['create', 'update', 'delete'] },
      // list on Services and PVCs: the orphan sweep lists them by label (spec §6.2).
      { apiGroups: [''], resources: ['services'], verbs: ['create', 'get', 'list', 'delete'] },
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
      {
        apiGroups: [''],
        resources: ['persistentvolumeclaims'],
        verbs: ['create', 'get', 'list', 'delete'],
      },
      {
        apiGroups: [''],
        resources: ['podtemplates'],
        resourceNames: ['moca-workload-sandbox'],
        verbs: ['get'],
      },
    ]);
    const rb = find(objs, 'RoleBinding', 'moca-provisioner', 'moca-sandbox');
    expect(rb.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'moca-provisioner', namespace: 'moca' },
    ]);
    const bindings = objs.filter(
      (o) =>
        (o.kind === 'RoleBinding' || o.kind === 'ClusterRoleBinding') &&
        JSON.stringify(o.subjects ?? []).includes('moca-provisioner'),
    );
    expect(bindings.map((o) => `${o.metadata.namespace}/${o.metadata.name}`)).toEqual([
      'moca-sandbox/moca-provisioner',
    ]);
  });

  it('runs exactly one provisioner, never two, on the target image with its image ID', () => {
    const dep = find(objs, 'Deployment', 'moca-provisioner', 'moca');
    expect(dep.spec.replicas).toBe(1);
    expect(dep.spec.strategy).toEqual({ type: 'Recreate' });
    expect(container(dep, 'provisioner').image).toBe('dev.local/moca:local');
    expect(dep.spec.template.metadata.annotations).toEqual({
      'moca.dev/image-id': 'sha256:harness',
    });
    const ocpDep = find(ocp, 'Deployment', 'moca-provisioner', 'moca');
    expect(container(ocpDep, 'provisioner').image).toBe('ghcr.io/me/moca:v1');
  });

  it('mounts its signing key and service token as files, never env', () => {
    const dep = find(objs, 'Deployment', 'moca-provisioner', 'moca');
    const c = container(dep, 'provisioner');
    expect(envVar(c, 'MOCA_ATTACH_PRIVATE_KEY')).toBeUndefined();
    expect(envVar(c, 'MOCA_PROVISIONER_TOKEN')).toBeUndefined();
    const vol = podSpec(dep).volumes.find((v: { name: string }) => v.name === 'credentials');
    expect(vol.secret.items.map((i: { key: string }) => i.key)).toEqual([
      'MOCA_ATTACH_PRIVATE_KEY',
      'MOCA_PROVISIONER_TOKEN',
    ]);
    expect(c.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
  });

  it("admits the supervisor to the API and workload pods to the seed port only, and reaches only the API server's addresses", () => {
    const p = find(objs, 'NetworkPolicy', 'moca-provisioner', 'moca');
    expect(p.spec.ingress).toEqual([
      {
        from: [{ podSelector: { matchLabels: { app: 'moca-supervisor' } } }],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
      {
        from: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'moca-sandbox' } },
            podSelector: { matchLabels: { app: 'moca-workload-sandbox' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8081 }],
      },
    ]);
    // The other half of the pair: workload pods' egress to the seed port, in its own policy.
    const seed = find(objs, 'NetworkPolicy', 'allow-seed-workload-sandbox', 'moca-sandbox');
    expect(seed.spec).toEqual({
      podSelector: { matchLabels: { app: 'moca-workload-sandbox' } },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'moca' } },
              podSelector: { matchLabels: { app: 'moca-provisioner' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 8081 }],
        },
      ],
    });
    const svc = find(objs, 'Service', 'moca-provisioner', 'moca');
    expect(svc.spec.ports).toContainEqual({ name: 'seed', port: 8081, targetPort: 'seed' });
    const c = container(find(objs, 'Deployment', 'moca-provisioner', 'moca'), 'provisioner');
    expect(envVar(c, 'MOCA_PROVISIONER_SEED_PORT')?.value).toBe('8081');
    expect(envVar(c, 'MOCA_PROVISIONER_SEED_BUDGET_BYTES')?.value).toBe(String(1024 ** 3));
    expect(p.spec.egress).toEqual(KUBE_API_EGRESS);
    expect(JSON.stringify(p)).not.toContain('0.0.0.0/0');
  });

  it("gives workload sandboxes the shared pool's egress, exceptions included, and a pod quota", () => {
    const wl = find(objs, 'NetworkPolicy', 'moca-workload-sandbox', 'moca-sandbox');
    const shared = find(objs, 'NetworkPolicy', 'moca-sandbox', 'moca-sandbox');
    expect(wl.spec.podSelector).toEqual({ matchLabels: { app: 'moca-workload-sandbox' } });
    expect(wl.spec.egress).toEqual(shared.spec.egress);
    expect(JSON.stringify(wl.spec.egress)).toContain('203.0.113.0/24');
    expect(wl.spec.ingress).toBeUndefined();
    find(objs, 'NetworkPolicy', 'allow-dns-workload-sandbox', 'moca-sandbox');
    // OpenShift DNS answers on 5353: on ocp only, workload pods get the shared pool's rule too.
    const ocpDns = find(
      ocp,
      'NetworkPolicy',
      'allow-openshift-dns-workload-sandbox',
      'moca-sandbox',
    );
    const sharedDns = find(ocp, 'NetworkPolicy', 'allow-openshift-dns', 'moca-sandbox');
    expect(ocpDns.spec.podSelector).toEqual({ matchLabels: { app: 'moca-workload-sandbox' } });
    expect(ocpDns.spec.egress).toEqual(sharedDns.spec.egress);
    expect(objs.some((o) => o.metadata.name === 'allow-openshift-dns-workload-sandbox')).toBe(
      false,
    );
    const q = find(objs, 'ResourceQuota', 'moca-sandbox', 'moca-sandbox');
    expect(q.spec.hard).toEqual({
      pods: '34',
      persistentvolumeclaims: '32',
      'requests.storage': '320Gi',
      // Every class of the cluster outside the allowlist holds no storage.
      'slow.storageclass.storage.k8s.io/requests.storage': '0',
    });
  });

  it("starts the pod template from the shared pool's container, without its relay token", () => {
    const t = find(objs, 'PodTemplate', 'moca-workload-sandbox', 'moca-sandbox');
    const shared = podSpec(find(objs, 'StatefulSet', 'moca-sandbox', 'moca-sandbox'));
    const pod = t.template.spec;
    expect(pod.serviceAccountName).toBe('moca-workload-sandbox');
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toEqual(shared.securityContext);
    const [c] = pod.containers;
    const [s] = shared.containers;
    expect(c.image).toBe(s.image);
    expect(c.image).toBe('dev.local/moca-remote-worker:local');
    expect(c.securityContext).toEqual(s.securityContext);
    expect(c.resources).toEqual(s.resources);
    expect(envVar(c, 'RELAY_ADDR')).toEqual(envVar(s, 'RELAY_ADDR'));
    // No Secret of any kind: the provisioner adds the workload's own attach token.
    expect(JSON.stringify(t)).not.toMatch(/secret/i);
    expect(envNames(c)).not.toContain('SANDBOX_TOKEN');
    // A rebuilt sandbox image reaches workloads created after it, as the shared pool's does.
    expect(t.template.metadata.annotations).toEqual({ 'moca.dev/image-id': 'sha256:sandbox' });
    const sa = find(objs, 'ServiceAccount', 'moca-workload-sandbox', 'moca-sandbox');
    expect(sa.automountServiceAccountToken).toBe(false);
    const ocpT = find(ocp, 'PodTemplate', 'moca-workload-sandbox', 'moca-sandbox');
    expect(ocpT.template.spec.containers[0].image).toBe('quay.io/me/rw:v2');
  });

  it("holds the provisioner's writes to workload names and a safe pod spec, at admission", () => {
    const vap = find(objs, 'ValidatingAdmissionPolicy', 'moca-provisioner');
    expect(vap.apiVersion).toBe('admissionregistration.k8s.io/v1');
    expect(vap.spec.failurePolicy).toBe('Fail');
    expect(vap.spec.matchConditions).toEqual([
      {
        name: 'from-the-provisioner',
        expression: "request.userInfo.username == 'system:serviceaccount:moca:moca-provisioner'",
      },
    ]);
    expect(vap.spec.matchConstraints.namespaceSelector).toEqual({
      matchLabels: { 'kubernetes.io/metadata.name': 'moca-sandbox' },
    });
    const rules = vap.spec.matchConstraints.resourceRules as {
      resources: string[];
      operations: string[];
    }[];
    expect(rules.flatMap((r) => r.resources).sort()).toEqual([
      'persistentvolumeclaims',
      'secrets',
      'services',
      'statefulsets',
    ]);
    for (const r of rules) expect(r.operations).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    const cel = JSON.stringify(vap.spec.validations);
    for (const needle of [
      '^w-[0-9a-f]{32}-attach$',
      '^w-[0-9a-f]{32}$',
      "'Opaque'",
      'moca-workload-sandbox',
      'automountServiceAccountToken == false',
      'hostNetwork',
      'hostPID',
      'privileged',
      'secretKeyRef',
      'secretRef',
      'volumeClaimTemplates',
      // Services: headless, port-less, own selector only.
      "svc.?clusterIP.orValue('') == 'None'",
      'externalIPs',
      'loadBalancerIP',
      "?selector['moca.dev/workload'].orValue('') == variables.wl",
      // Volumes: an allow-list, not a deny-list; a PVC only as the workload's own, once.
      'has(v.emptyDir) || has(v.configMap) || has(v.downwardAPI)',
      '(has(v.persistentVolumeClaim) && v.persistentVolumeClaim.claimName == variables.wl)',
      'size(variables.pod.volumes.filter(v, has(v.persistentVolumeClaim))) <= 1',
      'object.spec.storageClassName in variables.storageClasses',
      "m == 'ReadWriteMany' && object.spec.storageClassName in variables.rwxClasses",
      // A PVC is created empty: never a clone, a restore, a bound PV or a raw device.
      '!has(object.spec.dataSource) && !has(object.spec.dataSourceRef)',
      '!has(object.spec.volumeName) && !has(object.spec.selector)',
      "object.spec.?volumeMode.orValue('Filesystem') == 'Filesystem'",
      '!has(c.volumeDevices)',
    ]) {
      expect(cel, needle).toContain(needle);
    }
    // No volume source outside the allow-list is ever named as allowed. The CEL itself is
    // evaluated by the API server in deploy/k8s/tests/workload-admission.sh (k8s-e2e).
    expect(cel).not.toMatch(/has\(v\.(hostPath|projected|csi|ephemeral)\)/);
    // The allowlist, from setup.sh's resolved classes; rendered without it, every PVC is refused.
    const vars = Object.fromEntries(
      (vap.spec.variables as { name: string; expression: string }[]).map((v) => [
        v.name,
        v.expression,
      ]),
    );
    expect(vars.storageClasses).toBe("['standard','nfs']");
    // As checked in, before setup.sh fills it in: no class at all, so every PVC is refused.
    const raw = parseAllDocuments(
      readFileSync(resolve(K8S_DIR, 'base/workload-sandboxes/admission-policy.yaml'), 'utf8'),
    )[0]!.toJS() as K8sObject;
    const rawVars = raw.spec.variables as { name: string; expression: string }[];
    expect(rawVars.filter((v) => /Classes$/.test(v.name)).map((v) => v.expression)).toEqual([
      '[]',
      '[]',
    ]);
    expect(vars.rwxClasses).toBe("['nfs']");
    for (const name of ['moca-provisioner', 'moca-supervisor']) {
      const dep = find(objs, 'Deployment', name, 'moca');
      const c = podSpec(dep).containers[0];
      expect(envVar(c, 'MOCA_WORKLOAD_STORAGE_CLASSES')?.value, name).toBe('standard:rwo,nfs:rwx');
      expect(envVar(c, 'MOCA_WORKLOAD_MAX_STORAGE')?.value, name).toBe('10Gi');
      // The bundle ceilings: the workers' and the provisioner's are the same, or a hand-off the
      // workers accepted is refused (413 bundle_too_large).
      expect(envVar(c, 'MOCA_CONTEXT_BUNDLE_MAX_BYTES')?.value, name).toBe('268435456');
      expect(envVar(c, 'MOCA_CONTEXT_BUNDLE_MAX_ENTRIES')?.value, name).toBe('10000');
    }
    // One owner holds at most half the seed budget, so it is at least twice the largest bundle.
    const prov = podSpec(find(objs, 'Deployment', 'moca-provisioner', 'moca')).containers[0];
    expect(
      Number(envVar(prov, 'MOCA_PROVISIONER_SEED_BUDGET_BYTES')?.value),
    ).toBeGreaterThanOrEqual(2 * Number(envVar(prov, 'MOCA_CONTEXT_BUNDLE_MAX_BYTES')?.value));
    const binding = find(objs, 'ValidatingAdmissionPolicyBinding', 'moca-provisioner');
    expect(binding.spec).toEqual({ policyName: 'moca-provisioner', validationActions: ['Deny'] });
  });

  it('wires the relay and supervisor to it, and lets workload sandboxes attach', () => {
    const relay = container(find(objs, 'Deployment', 'sandbox-relay', 'moca'), 'sandbox-relay');
    expect(envVar(relay, 'MOCA_ATTACH_PUBLIC_KEYS')?.valueFrom).toEqual({
      secretKeyRef: { name: 'moca-provisioner', key: 'MOCA_ATTACH_PUBLIC_KEYS' },
    });
    expect(JSON.stringify(relay)).not.toContain('MOCA_ATTACH_PRIVATE_KEY');
    const sup = container(find(objs, 'Deployment', 'moca-supervisor', 'moca'), 'supervisor');
    expect(envVar(sup, 'MOCA_PROVISIONER_URL')?.value).toBe(
      'http://moca-provisioner.moca.svc:8080',
    );
    expect(envVar(sup, 'MOCA_PROVISIONER_TOKEN')?.valueFrom).toEqual({
      secretKeyRef: { name: 'moca-provisioner', key: 'MOCA_PROVISIONER_TOKEN' },
    });
    expect(JSON.stringify(sup)).not.toContain('MOCA_ATTACH_PRIVATE_KEY');
    const np = find(objs, 'NetworkPolicy', 'sandbox-relay', 'moca');
    const attach = np.spec.ingress.find(
      (r: { ports: { port: number }[] }) => r.ports[0]!.port === 9443,
    );
    expect(attach.from).toContainEqual({
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'moca-sandbox' } },
      podSelector: { matchLabels: { app: 'moca-workload-sandbox' } },
    });
    const exec = np.spec.ingress.find(
      (r: { ports: { port: number }[] }) => r.ports[0]!.port === 9444,
    );
    expect(JSON.stringify(exec)).not.toContain('moca-workload-sandbox');
    expect(find(objs, 'NetworkPolicy', 'moca-supervisor', 'moca').spec.egress).toContainEqual({
      to: [{ podSelector: { matchLabels: { app: 'moca-provisioner' } } }],
      ports: [{ protocol: 'TCP', port: 8080 }],
    });
  });

  it('reaches Redis for the orphan sweep (spec §6.2), as its own ACL user (#626), and DNS', () => {
    const c = container(find(objs, 'Deployment', 'moca-provisioner', 'moca'), 'provisioner');
    // Its own Secret, whose URL names its read-only user: never moca-redis's read-write password.
    expect(envVar(c, 'REDIS_URL')?.valueFrom).toEqual({
      secretKeyRef: { name: 'moca-redis-provisioner', key: 'REDIS_URL' },
    });
    expect(
      JSON.stringify(podSpec(find(objs, 'Deployment', 'moca-provisioner', 'moca'))),
    ).not.toMatch(/"moca-redis"/);
    expect(envVar(c, 'MOCA_PROVISIONER_ORPHAN_GRACE_S')?.value).toBe('600');
    expect(envVar(c, 'MOCA_PROVISIONER_RECONCILE_S')?.value).toBe('300');
    // Its own policy: setup.sh replaces moca-provisioner's egress with the API server's addresses.
    const p = find(objs, 'NetworkPolicy', 'moca-provisioner-redis', 'moca');
    expect(p.spec).toEqual({
      podSelector: { matchLabels: { app: 'moca-provisioner' } },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{ podSelector: { matchLabels: { app: 'redis' } } }],
          ports: [{ protocol: 'TCP', port: 6379 }],
        },
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
              podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
            },
          ],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
      ],
    });
    expect(find(objs, 'NetworkPolicy', 'moca-provisioner', 'moca').spec.egress).toEqual(
      KUBE_API_EGRESS,
    );
    // Redis admits it, on its one port, beside the base's three.
    const redis = find(objs, 'NetworkPolicy', 'redis', 'moca');
    expect(
      redis.spec.ingress[0].from.map(
        (f: { podSelector: { matchLabels: { app: string } } }) => f.podSelector.matchLabels.app,
      ),
    ).toEqual(['moca-supervisor', 'sandbox-relay', 'moca-control-plane', 'moca-provisioner']);
    expect(redis.spec.ingress[0].ports).toEqual([{ protocol: 'TCP', port: 6379 }]);
    // OpenShift DNS answers on 5353: on ocp only, the provisioner gets that rule too.
    const ocpDns = find(ocp, 'NetworkPolicy', 'allow-openshift-dns-provisioner', 'moca');
    expect(ocpDns.spec.podSelector).toEqual({ matchLabels: { app: 'moca-provisioner' } });
    expect(ocpDns.spec.egress).toEqual(
      find(ocp, 'NetworkPolicy', 'allow-openshift-dns', 'moca').spec.egress,
    );
    expect(objs.some((o) => o.metadata.name === 'allow-openshift-dns-provisioner')).toBe(false);
  });

  it("rolls Redis on its provisioner user's hash: Redis reads redis.conf only at start (#626)", () => {
    for (const render of [objs, ocp]) {
      const redis = find(render, 'StatefulSet', 'redis', 'moca');
      expect(redis.spec.template.metadata.annotations).toEqual({
        'moca.dev/redis-acl-hash': REDIS_ACL_HASH,
      });
      // Still the one Secret's redis.conf: the user is defined there, beside requirepass.
      expect(podSpec(redis).volumes).toContainEqual(
        expect.objectContaining({
          secret: expect.objectContaining({ secretName: 'moca-redis' }),
        }),
      );
    }
  });

  it('leaves every image the base and target set unchanged', () => {
    for (const [kind, name, ns] of [
      ['Deployment', 'moca-supervisor', 'moca'],
      ['Deployment', 'sandbox-relay', 'moca'],
      ['StatefulSet', 'moca-sandbox', 'moca-sandbox'],
    ] as const) {
      const images = podSpec(find(objs, kind, name, ns)).containers.map(
        (c: { image: string }) => c.image,
      );
      expect(
        images.every((i: string) => i.startsWith('dev.local/')),
        `${kind}/${name}`,
      ).toBe(true);
    }
  });
});
