import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { K8S_DIR, NO_KUBECTL, container, envVar, find, podSpec, type K8sObject } from './render.js';

/**
 * The overlay setup.sh GENERATES for --target ocp, rendered through real `kubectl kustomize` (#423).
 *
 * The checked-in overlays are covered by overlay-ocp.test.ts, but everything per-run -- Route hosts,
 * image overrides, replicas, the settings hash -- lives only in the generated kustomization, which
 * the bash tests check as text and nothing used to render. A patch that targets the wrong name, or an
 * `images:` entry that matches nothing because the base already rewrote the placeholder, renders
 * without an error and silently does nothing.
 *
 * The kustomization is written by setup.sh's own write_overlay (sourced by the fixture), so the
 * text under test cannot drift from the script. It lands in deploy/k8s/.generated/test-ocp/
 * (gitignored), at the same depth as .generated/ocp, so its `../../overlays/ocp` resolves.
 */
const DIR = resolve(K8S_DIR, '.generated/test-ocp');
const WRITER = fileURLToPath(new URL('./fixtures/write-generated-overlay.sh', import.meta.url));
const DIGEST = `sha256:${'0123456789abcdef'.repeat(4)}`;
const HASH = 'f'.repeat(64);
const SUP_HOST = 'moca-moca.apps.example.test';
const CP_HOST = 'moca-control-plane-moca.apps.example.test';
const BUILTIN_EXCEPT = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
];

describe.skipIf(NO_KUBECTL)('the generated OCP overlay (setup.sh write_overlay)', () => {
  let objs: K8sObject[] = [];
  beforeAll(() => {
    execFileSync('bash', [WRITER, DIR], {
      env: {
        ...process.env,
        GO_TARGET: 'ocp',
        GO_IMAGE: 'ghcr.io/me/moca:v1',
        GO_SANDBOX_IMAGE: `quay.io/me/rw@${DIGEST}`,
        GO_SUP_HOST: SUP_HOST,
        GO_CP_HOST: CP_HOST,
        GO_SANDBOX_COUNT: '3',
        GO_CLIENT_ID: 'Iv1.generated-overlay-test',
        GO_SETTINGS_HASH: HASH,
        GO_WORKSPACE_IDLE: '12h',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const out = execFileSync('kubectl', ['kustomize', DIR], { encoding: 'utf8' });
    objs = parseAllDocuments(out)
      .map((d) => d.toJS() as K8sObject | null)
      .filter((o): o is K8sObject => o !== null);
  });
  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('was written where the test expects, building on overlays/ocp', () => {
    expect(existsSync(resolve(DIR, 'kustomization.yaml'))).toBe(true);
  });

  it('patches both Route hosts', () => {
    expect(find(objs, 'Route', 'moca', 'moca').spec.host).toBe(SUP_HOST);
    expect(find(objs, 'Route', 'moca-control-plane', 'moca').spec.host).toBe(CP_HOST);
  });

  it('rewrites the harness image by tag and the sandbox image by digest', () => {
    for (const [kind, name] of [
      ['Deployment', 'moca-supervisor'],
      ['Deployment', 'sandbox-relay'],
      ['Deployment', 'moca-control-plane'],
    ] as const) {
      const images = podSpec(find(objs, kind, name, 'moca')).containers.map(
        (c: { image: string }) => c.image,
      );
      expect(images, `${kind}/${name}`).toContain('ghcr.io/me/moca:v1');
    }
    const sandbox = podSpec(find(objs, 'StatefulSet', 'moca-sandbox', 'moca-sandbox'));
    expect(sandbox.containers.map((c: { image: string }) => c.image)).toContain(
      `quay.io/me/rw@${DIGEST}`,
    );
    // Nothing still points at the default images: an `images:` entry that matched nothing would
    // leave them here without any error from kustomize.
    const all = JSON.stringify(objs);
    expect(all).not.toContain('ghcr.io/rossoctl/moca:latest');
    expect(all).not.toContain('ghcr.io/rossoctl/moca-remote-worker');
  });

  it('runs the control plane at 1 replica and the sandboxes at SH_SANDBOX_COUNT', () => {
    expect(find(objs, 'Deployment', 'moca-control-plane', 'moca').spec.replicas).toBe(1);
    expect(find(objs, 'StatefulSet', 'moca-sandbox', 'moca-sandbox').spec.replicas).toBe(3);
  });

  it('stamps the settings hash on the control plane and supervisor pod templates', () => {
    const cp = find(objs, 'Deployment', 'moca-control-plane', 'moca');
    expect(cp.spec.template.metadata.annotations['moca.dev/settings-hash']).toBe(HASH);
    // The supervisor reads the sandbox tiers from moca-settings too (P6.3), so a change rolls it.
    const sup = find(objs, 'Deployment', 'moca-supervisor', 'moca');
    expect(sup.spec.template.metadata.annotations['moca.dev/settings-hash']).toBe(HASH);
  });

  it('stamps the idle reclaim on the sandbox pod template alone, so a change rolls only them (#338)', () => {
    const sts = find(objs, 'StatefulSet', 'moca-sandbox', 'moca-sandbox');
    expect(sts.spec.template.metadata.annotations).toEqual({ 'moca.dev/workspace-idle': '12h' });
    // ...beside the replicas patch in the same entry, and the ConfigMap read the base sets.
    expect(sts.spec.replicas).toBe(3);
    expect(envVar(container(sts, 'sandbox'), 'SH_WORKSPACE_IDLE')?.valueFrom).toEqual({
      configMapKeyRef: { name: 'moca-sandbox-settings', key: 'SH_WORKSPACE_IDLE', optional: true },
    });
  });

  it('leaves the sandbox egress except list at the built-in ranges with no SH_SANDBOX_EGRESS_EXCEPT', () => {
    const p = find(objs, 'NetworkPolicy', 'moca-sandbox', 'moca-sandbox');
    expect([...p.spec.egress[1].to[0].ipBlock.except].sort()).toEqual([...BUILTIN_EXCEPT].sort());
  });

  it("leaves Redis's pod template unannotated without workload sandboxes (no provisioner user, #626)", () => {
    expect(
      find(objs, 'StatefulSet', 'redis', 'moca').spec.template.metadata.annotations,
    ).toBeUndefined();
  });

  it('renders nothing of P4 with no P4 IDs, so the relay matches slice 1', () => {
    const names = objs.map((o) => `${o.kind}/${o.metadata.name}`);
    expect(names).not.toContain('Route/moca-relay');
    expect(names).not.toContain('Service/sandbox-relay-tls');
    expect(names).not.toContain('NetworkPolicy/sandbox-relay-from-router');
    const relay = podSpec(find(objs, 'Deployment', 'sandbox-relay', 'moca'));
    expect(relay.containers.map((c: { name: string }) => c.name)).toEqual(['sandbox-relay']);
  });
});

describe.skipIf(NO_KUBECTL)(
  'the generated OCP overlay with P4 IDs (setup.sh write_overlay)',
  () => {
    const P4_DIR = resolve(K8S_DIR, '.generated/test-ocp-p4');
    const RELAY_HOST = 'moca-relay-moca.apps.example.test';
    let objs: K8sObject[] = [];
    beforeAll(() => {
      execFileSync('bash', [WRITER, P4_DIR], {
        env: {
          ...process.env,
          GO_TARGET: 'ocp',
          GO_SUP_HOST: SUP_HOST,
          GO_CP_HOST: CP_HOST,
          GO_SANDBOX_COUNT: '0',
          GO_CLIENT_ID: 'Iv1.generated-overlay-test',
          GO_SETTINGS_HASH: HASH,
          GO_P4_IDS: 'moca_microvm_0 moca_microvm_1',
          GO_RELAY_HOST: RELAY_HOST,
        },
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      const out = execFileSync('kubectl', ['kustomize', P4_DIR], { encoding: 'utf8' });
      objs = parseAllDocuments(out)
        .map((d) => d.toJS() as K8sObject | null)
        .filter((o): o is K8sObject => o !== null);
    });
    afterAll(() => {
      rmSync(P4_DIR, { recursive: true, force: true });
    });

    it('includes the p4-relay component, with the relay Route host patched', () => {
      const route = find(objs, 'Route', 'moca-relay', 'moca');
      expect(route.spec.host).toBe(RELAY_HOST);
      expect(route.spec.tls.termination).toBe('passthrough');
      expect(find(objs, 'Service', 'sandbox-relay-tls', 'moca').spec.ports[0].port).toBe(8444);
      find(objs, 'NetworkPolicy', 'sandbox-relay-from-router', 'moca'); // throws when absent
    });

    it('gives the relay its TLS sidecar beside the relay container, which keeps the token dir', () => {
      const relay = podSpec(find(objs, 'Deployment', 'sandbox-relay', 'moca'));
      expect(relay.containers.map((c: { name: string }) => c.name).sort()).toEqual([
        'sandbox-relay',
        'tls',
      ]);
      const env = relay.containers.find((c: { name: string }) => c.name === 'sandbox-relay').env;
      expect(env).toContainEqual({ name: 'SH_RELAY_TOKEN_DIR', value: '/run/relay-tokens' });
    });

    it('keeps the supervisor and control plane patches of the no-P4 render', () => {
      expect(find(objs, 'Route', 'moca', 'moca').spec.host).toBe(SUP_HOST);
      expect(find(objs, 'StatefulSet', 'moca-sandbox', 'moca-sandbox').spec.replicas).toBe(0);
    });
  },
);

describe.skipIf(NO_KUBECTL)(
  'the generated ocp-single overlay with Routes (setup.sh write_overlay)',
  () => {
    // Not overlay-ocp-single-routes.test.ts's .generated/test-ocp-single-routes: vitest runs the two
    // files in parallel, and each one's afterAll removes its directory under the other's kustomize.
    const DIR = resolve(K8S_DIR, '.generated/test-generated-ocp-single-routes');
    const DOMAIN = 'example.test';
    const NS = 'moca-tenant-1';
    let objs: K8sObject[] = [];
    beforeAll(() => {
      execFileSync('bash', [WRITER, DIR], {
        env: {
          ...process.env,
          GO_TARGET: 'ocp-single',
          GO_NS: NS,
          GO_SBX_NS: NS,
          GO_SANDBOX_COUNT: '2',
          GO_CLIENT_ID: 'Iv1.generated-overlay-test',
          GO_SETTINGS_HASH: HASH,
          GO_ROUTE_DOMAIN: DOMAIN,
          GO_TLS_SECRET: 'op-cert',
        },
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      const out = execFileSync('kubectl', ['kustomize', DIR], { encoding: 'utf8' });
      objs = parseAllDocuments(out)
        .map((d) => d.toJS() as K8sObject | null)
        .filter((o): o is K8sObject => o !== null);
    });
    afterAll(() => {
      rmSync(DIR, { recursive: true, force: true });
    });

    it('lists the routes component and patches both Route hosts to the domain', () => {
      expect(find(objs, 'Route', 'moca', NS).spec.host).toBe(`moca.${DOMAIN}`);
      expect(find(objs, 'Route', 'moca-control-plane', NS).spec.host).toBe(
        `moca-control-plane.${DOMAIN}`,
      );
    });

    it('points the sidecar volume at the --tls-secret Secret, not the default name', () => {
      const vol = podSpec(find(objs, 'Deployment', 'moca-supervisor', NS)).volumes.find(
        (v: { name: string }) => v.name === 'tls',
      );
      expect(vol.secret.secretName).toBe('op-cert');
    });

    it('keeps the namespace transformer and the env-string rewrites of the no-Routes render', () => {
      const supervisor = container(find(objs, 'Deployment', 'moca-supervisor', NS), 'supervisor');
      expect(envVar(supervisor, 'SH_RELAY_ADDR')?.value).toBe(`sandbox-relay-exec.${NS}.svc:9444`);
      find(objs, 'Service', 'moca-supervisor-tls', NS); // throws when absent
    });

    it('stamps the settings hash on both pod templates alongside the routes component', () => {
      // The routes component and the --tls-secret volume patch both touch moca-supervisor; the
      // settings-hash "add" must still create the annotations map exactly once and survive them.
      for (const name of ['moca-control-plane', 'moca-supervisor']) {
        const d = find(objs, 'Deployment', name, NS);
        expect(d.spec.template.metadata.annotations, name).toEqual({
          'moca.dev/settings-hash': HASH,
        });
      }
      const containers = podSpec(find(objs, 'Deployment', 'moca-supervisor', NS)).containers.map(
        (c: { name: string }) => c.name,
      );
      expect(containers).toEqual(expect.arrayContaining(['supervisor', 'tls']));
    });
  },
);

describe.skipIf(NO_KUBECTL)(
  'the generated ocp-single overlay with a custom namespace (setup.sh write_overlay)',
  () => {
    // A custom namespace is the case where write_overlay also emits env patches for the supervisor
    // and the control plane: the settings-hash patch is a second entry for the same Deployment, and
    // kustomize must apply both.
    const SINGLE_DIR = resolve(K8S_DIR, '.generated/test-ocp-single');
    const NS = 'moca-tenant-1';
    let objs: K8sObject[] = [];
    beforeAll(() => {
      execFileSync('bash', [WRITER, SINGLE_DIR], {
        env: {
          ...process.env,
          GO_TARGET: 'ocp-single',
          GO_NS: NS,
          GO_SBX_NS: NS,
          GO_SANDBOX_COUNT: '2',
          GO_CLIENT_ID: 'Iv1.generated-overlay-test',
          GO_SETTINGS_HASH: HASH,
        },
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      const out = execFileSync('kubectl', ['kustomize', SINGLE_DIR], { encoding: 'utf8' });
      objs = parseAllDocuments(out)
        .map((d) => d.toJS() as K8sObject | null)
        .filter((o): o is K8sObject => o !== null);
    });
    afterAll(() => {
      rmSync(SINGLE_DIR, { recursive: true, force: true });
    });

    it('stamps the settings hash on both pod templates and keeps their env patches', () => {
      for (const name of ['moca-control-plane', 'moca-supervisor']) {
        const d = find(objs, 'Deployment', name, NS);
        expect(d.spec.template.metadata.annotations, name).toEqual({
          'moca.dev/settings-hash': HASH,
        });
      }
      const sup = podSpec(find(objs, 'Deployment', 'moca-supervisor', NS)).containers.find(
        (c: { name: string }) => c.name === 'supervisor',
      );
      expect(sup.env).toContainEqual({
        name: 'SH_RELAY_ADDR',
        value: `sandbox-relay-exec.${NS}.svc:9444`,
      });
      const cp = podSpec(find(objs, 'Deployment', 'moca-control-plane', NS)).containers.find(
        (c: { name: string }) => c.name === 'control-plane',
      );
      expect(cp.env).toContainEqual({ name: 'SH_SANDBOX_NAMESPACE', value: NS });
      // The idle annotation survives ocp-single's own emptyDir patch of the sandboxes (#338).
      const sts = find(objs, 'StatefulSet', 'moca-sandbox', NS);
      expect(sts.spec.template.metadata.annotations).toEqual({ 'moca.dev/workspace-idle': '8h' });
      expect(podSpec(sts).volumes).toContainEqual({ name: 'workspace', emptyDir: {} });
    });

    it('keeps the sandbox tiers identical on the supervisor and the control plane through the env patches (P6.3 spec §7)', () => {
      // The one overlay where write_overlay patches both Deployments' env: a patch that replaced the
      // env list, or dropped an entry, would split the two (env-parity.test.ts checks base only).
      const sup = container(find(objs, 'Deployment', 'moca-supervisor', NS), 'supervisor');
      const cp = container(find(objs, 'Deployment', 'moca-control-plane', NS), 'control-plane');
      for (const name of ['SH_SANDBOX_TIERS', 'SH_SANDBOX_DEFAULT_TIER']) {
        expect(envVar(sup, name), `supervisor ${name}`).toBeDefined();
        expect(envVar(cp, name), `control plane ${name}`).toBeDefined();
        expect(envVar(sup, name), name).toEqual(envVar(cp, name));
      }
    });
  },
);

/** Renders setup.sh's generated overlay for `target` into `dir` with the given GO_* environment. */
function renderGenerated(dir: string, env: Record<string, string>): K8sObject[] {
  execFileSync('bash', [WRITER, dir], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const out = execFileSync('kubectl', ['kustomize', dir], { encoding: 'utf8' });
  return parseAllDocuments(out)
    .map((d) => d.toJS() as K8sObject | null)
    .filter((o): o is K8sObject => o !== null);
}

const HARNESS_ID = `sha256:${'a'.repeat(64)}`;
const SANDBOX_ID = `sha256:${'b'.repeat(64)}`;

describe.skipIf(NO_KUBECTL)('the generated kind overlay stamps the loaded image IDs', () => {
  // A rebuilt image keeps its `:local` tag, so without a pod-template change the apply rolls nothing
  // and the pods keep running the old image. The image-ID annotation is that change.
  const KIND_DIR = resolve(K8S_DIR, '.generated/test-kind');
  let objs: K8sObject[] = [];
  beforeAll(() => {
    objs = renderGenerated(KIND_DIR, {
      GO_TARGET: 'kind',
      GO_SANDBOX_COUNT: '2',
      GO_CLIENT_ID: 'Iv1.generated-overlay-test',
      GO_SETTINGS_HASH: HASH,
      GO_HARNESS_IMAGE_ID: HARNESS_ID,
      GO_SANDBOX_IMAGE_ID: SANDBOX_ID,
    });
  });
  afterAll(() => {
    rmSync(KIND_DIR, { recursive: true, force: true });
  });

  it('stamps the harness image ID beside the settings hash on the control plane and supervisor', () => {
    for (const name of ['moca-control-plane', 'moca-supervisor']) {
      expect(
        find(objs, 'Deployment', name, 'moca').spec.template.metadata.annotations,
        name,
      ).toEqual({ 'moca.dev/settings-hash': HASH, 'moca.dev/image-id': HARNESS_ID });
    }
  });

  it('stamps the harness image ID on the relay and the sandbox image ID on the sandboxes, beside the default idle', () => {
    expect(
      find(objs, 'Deployment', 'sandbox-relay', 'moca').spec.template.metadata.annotations,
    ).toEqual({ 'moca.dev/image-id': HARNESS_ID });
    expect(
      find(objs, 'StatefulSet', 'moca-sandbox', 'moca-sandbox').spec.template.metadata.annotations,
    ).toEqual({ 'moca.dev/workspace-idle': '8h', 'moca.dev/image-id': SANDBOX_ID });
  });
});

describe.skipIf(NO_KUBECTL)('the generated OCP overlay stamps no image ID', () => {
  // OpenShift pulls by tag or digest from a registry; setup.sh loads nothing there, so there is no ID.
  const OCP_DIR = resolve(K8S_DIR, '.generated/test-ocp-noid');
  let objs: K8sObject[] = [];
  beforeAll(() => {
    objs = renderGenerated(OCP_DIR, {
      GO_TARGET: 'ocp',
      GO_SUP_HOST: SUP_HOST,
      GO_CP_HOST: CP_HOST,
      GO_SANDBOX_COUNT: '1',
      GO_CLIENT_ID: 'Iv1.generated-overlay-test',
      GO_SETTINGS_HASH: HASH,
      GO_HARNESS_IMAGE_ID: HARNESS_ID,
      GO_SANDBOX_IMAGE_ID: SANDBOX_ID,
    });
  });
  afterAll(() => {
    rmSync(OCP_DIR, { recursive: true, force: true });
  });

  it('leaves the image-id annotation off every workload', () => {
    expect(JSON.stringify(objs)).not.toContain('moca.dev/image-id');
  });
});

// SH_SANDBOX_EGRESS_EXCEPT (#446): the extra ranges land in the sandbox's internet rule, after the
// built-in ones, on the base's policy (ocp, and kind through the same base) and on ocp-single's
// replacement of it -- including under a custom namespace, where the namespace transformer runs
// after the patch.
for (const [target, ns] of [
  ['ocp', 'moca-sandbox'],
  ['ocp-single', 'moca-tenant-1'],
] as const) {
  describe.skipIf(NO_KUBECTL)(
    `the generated ${target} overlay with SH_SANDBOX_EGRESS_EXCEPT (setup.sh write_overlay)`,
    () => {
      const DIR = resolve(K8S_DIR, `.generated/test-egress-${target}`);
      const EXTRA = ['203.0.113.0/24', '198.51.100.7/32'];
      let objs: K8sObject[] = [];
      beforeAll(() => {
        execFileSync('bash', [WRITER, DIR], {
          env: {
            ...process.env,
            GO_TARGET: target,
            ...(target === 'ocp-single' ? { GO_NS: ns, GO_SBX_NS: ns } : {}),
            GO_SUP_HOST: SUP_HOST,
            GO_CP_HOST: CP_HOST,
            GO_SANDBOX_COUNT: '2',
            GO_CLIENT_ID: 'Iv1.generated-overlay-test',
            GO_SETTINGS_HASH: HASH,
            GO_EGRESS_EXCEPT: EXTRA.join(' '),
          },
          stdio: ['ignore', 'ignore', 'inherit'],
        });
        const out = execFileSync('kubectl', ['kustomize', DIR], { encoding: 'utf8' });
        objs = parseAllDocuments(out)
          .map((d) => d.toJS() as K8sObject | null)
          .filter((o): o is K8sObject => o !== null);
      });
      afterAll(() => {
        rmSync(DIR, { recursive: true, force: true });
      });

      it('appends the ranges to the internet rule, keeping the built-in ones and all ports', () => {
        const p = find(objs, 'NetworkPolicy', 'moca-sandbox', ns);
        const rule = p.spec.egress[1];
        expect(rule.to[0].ipBlock.cidr).toBe('0.0.0.0/0');
        expect(rule.to[0].ipBlock.except).toEqual([...BUILTIN_EXCEPT, ...EXTRA]);
        expect(rule.ports).toBeUndefined();
      });

      it('leaves the relay rule alone', () => {
        const p = find(objs, 'NetworkPolicy', 'moca-sandbox', ns);
        expect(p.spec.egress[0].ports).toEqual([{ protocol: 'TCP', port: 9443 }]);
        expect(p.spec.egress).toHaveLength(2);
      });
    },
  );
}

/**
 * The two settings stamps are not one value on a profile that serves sbx: setup.sh hashes
 * moca-settings plus the test-user digest into CORE_SETTINGS_HASH for the supervisor, and folds
 * sbx-settings in on top for the control plane and the relay, so a changed template or quota does
 * not roll a supervisor that reads none of those keys. Rendered here because the bash suite checks
 * the generated TEXT: only kustomize says whether two different "add annotations" patches against
 * two Deployments both survive, and an earlier cut of this split stamped the supervisor from a
 * variable nothing set, which rendered an empty annotation that every text-level check accepted.
 */
describe.skipIf(NO_KUBECTL)('the generated overlay with a distinct core settings hash', () => {
  const CORE_DIR = resolve(K8S_DIR, '.generated/test-ocp-core-hash');
  const CORE_HASH = 'a'.repeat(64);
  let objs: K8sObject[] = [];
  beforeAll(() => {
    execFileSync('bash', [WRITER, CORE_DIR], {
      env: {
        ...process.env,
        GO_TARGET: 'ocp',
        GO_SANDBOX_COUNT: '2',
        GO_CLIENT_ID: 'Iv1.core-hash-test',
        GO_SETTINGS_HASH: HASH,
        GO_CORE_SETTINGS_HASH: CORE_HASH,
        GO_WORKSPACE_IDLE: '8h',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const out = execFileSync('kubectl', ['kustomize', CORE_DIR], { encoding: 'utf8' });
    objs = parseAllDocuments(out)
      .map((d) => d.toJS() as K8sObject | null)
      .filter((o): o is K8sObject => o !== null);
  });
  afterAll(() => {
    rmSync(CORE_DIR, { recursive: true, force: true });
  });

  it('stamps the supervisor with the core hash and the control plane with the full one', () => {
    expect(
      find(objs, 'Deployment', 'moca-supervisor', 'moca').spec.template.metadata.annotations,
    ).toEqual({ 'moca.dev/settings-hash': CORE_HASH });
    expect(
      find(objs, 'Deployment', 'moca-control-plane', 'moca').spec.template.metadata.annotations,
    ).toEqual({ 'moca.dev/settings-hash': HASH });
    // Neither is empty, which is the shape of the bug this case exists for: an unset variable
    // renders `settings-hash: ""`, which is a stamp that never changes and so never rolls anything.
    for (const name of ['moca-supervisor', 'moca-control-plane']) {
      const stamp = find(objs, 'Deployment', name, 'moca').spec.template.metadata.annotations[
        'moca.dev/settings-hash'
      ];
      expect(stamp, name).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
