import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
} from './render.js';

/**
 * The sandbox service on an ocp-single stack: overlays/ocp-single/combined, rendered the way
 * setup.sh's generated overlay lists it (../routes is the precedent, and
 * forwarded-headers.test.ts renders that component the same way). Two things these tests exist for:
 *
 * - the profile must ADD and never remove. A harness object that disappears here is a regression
 *   for every stack already running, so the render is compared object for object against
 *   overlays/ocp-single alone.
 * - the exec path is REUSED from overlays/ocp-sbx/exec-tls, whose objects and whose patch declare
 *   the base namespace rather than this overlay's. That the patch still matches after the parent's
 *   namespace transformer has run is the assumption reuse rests on, so the sidecar is asserted
 *   rather than assumed -- without it the Route would answer with no backend.
 */
const DIR = resolve(K8S_DIR, '.generated/test-sbx-service');
const NS = 'moca-single';
const id = (o: K8sObject) => `${o.kind}/${o.metadata.name}`;

function renderCombined(): K8sObject[] {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    resolve(DIR, 'kustomization.yaml'),
    [
      'apiVersion: kustomize.config.k8s.io/v1beta1',
      'kind: Kustomization',
      'resources:',
      '  - ../../overlays/ocp-single',
      'components:',
      '  - ../../overlays/ocp-single/combined',
      `namespace: ${NS}`,
      '',
    ].join('\n'),
  );
  const out = execFileSync('kubectl', ['kustomize', DIR], { encoding: 'utf8' });
  return parseAllDocuments(out)
    .map((d) => d.toJS() as K8sObject | null)
    .filter((o): o is K8sObject => o !== null);
}

const SANDBOX_DIR = resolve(K8S_DIR, '.generated/test-sbx-sandbox');

/**
 * The SANDBOX-ONLY profile, rendered the same way (overlays/ocp-single/sandbox). Its two claims are
 * what these tests exist for, because neither is visible in setup.sh's generated kustomization --
 * which is all the mocked deploy/k8s/tests/setup.test.sh can see -- so only a real render catches
 * a patch that stops applying:
 *
 * - the supervisor is held at 0 replicas. It serves sessions this profile does not mount, and
 *   leaving it at 1 runs a pod against a control plane that answers it nothing.
 * - the control plane boots at all: this profile REFUSES a credential KEK without egress hosts and
 *   needs no credential store, so the patch must remove both -- and the credentials volume is
 *   re-listed, which a wrong source list turns into a crashloop on an empty or missing file.
 */
function renderSandbox(): K8sObject[] {
  mkdirSync(SANDBOX_DIR, { recursive: true });
  writeFileSync(
    resolve(SANDBOX_DIR, 'kustomization.yaml'),
    [
      'apiVersion: kustomize.config.k8s.io/v1beta1',
      'kind: Kustomization',
      'resources:',
      '  - ../../overlays/ocp-single',
      'components:',
      '  - ../../overlays/ocp-single/sandbox',
      `namespace: ${NS}`,
      '',
    ].join('\n'),
  );
  const out = execFileSync('kubectl', ['kustomize', SANDBOX_DIR], { encoding: 'utf8' });
  return parseAllDocuments(out)
    .map((d) => d.toJS() as K8sObject | null)
    .filter((o): o is K8sObject => o !== null);
}

describe.skipIf(NO_KUBECTL)('overlays/ocp-single/sandbox: the sandbox-only profile', () => {
  afterAll(() => rmSync(SANDBOX_DIR, { recursive: true, force: true }));

  it('holds the supervisor at 0 replicas and keeps every sandbox object', () => {
    const objs = renderSandbox();
    // The defining claim of the profile. Asserted on the rendered value, not on the patch file.
    expect(find(objs, 'Deployment', 'moca-supervisor').spec.replicas).toBe(0);
    // Kept as an object rather than deleted, so switching back is a replica change and its
    // ServiceAccount, Service and NetworkPolicy stay where the other manifests expect them.
    // (No Role: only the control plane has one, for credential Secrets.)
    for (const kind of ['ServiceAccount', 'Service', 'NetworkPolicy']) {
      expect(() => find(objs, kind, 'moca-supervisor')).not.toThrow();
    }
    // The sandbox half still comes from ../sbx-service through the component chain.
    expect(() => find(objs, 'Deployment', 'sbx-worker')).not.toThrow();
  });

  it('removes exactly what the sandbox profile refuses to boot with', () => {
    const cp = container(
      find(renderSandbox(), 'Deployment', 'moca-control-plane'),
      'control-plane',
    );
    expect(envVar(cp, 'SH_ROUTE_PROFILE')?.value).toBe('sandbox');
    // sandboxConfigFromEnv pairs the KEK with SH_EGRESS_HOSTS -- both or neither -- and this
    // profile serves no credential issuance, so both of these must be gone.
    expect(envNames(cp)).not.toContain('SH_CREDENTIAL_STORE');
    expect(envNames(cp)).not.toContain('SH_CREDENTIAL_NAMESPACE');
    const vol = podSpec(find(renderSandbox(), 'Deployment', 'moca-control-plane')).volumes.find(
      (v: { name: string }) => v.name === 'credentials',
    );
    // One source type per volume: a `secret:` left beside `projected:` is refused by the API
    // server, and the KEK must not be among the sources.
    expect(vol.secret).toBeUndefined();
    const keys = vol.projected.sources.flatMap(
      (src: { secret?: { items?: { key: string }[] } }) =>
        src.secret?.items?.map((i) => i.key) ?? [],
    );
    expect(keys).not.toContain('SH_CREDENTIAL_KEK');
    expect(keys).toContain('SH_TEST_USER_SECRET');
  });
});

describe.skipIf(NO_KUBECTL)('overlays/ocp-single/combined: the sandbox service', () => {
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it('adds objects without removing or renaming any harness object', () => {
    const harness = render('overlays/ocp-single').map(id).sort();
    const combined = renderCombined().map(id);
    expect([...new Set(combined)].length, 'a duplicate object id in the render').toBe(
      combined.length,
    );
    for (const o of harness) expect(combined, `${o} vanished on the combined profile`).toContain(o);
    // The supervisor still serves the harness: this profile adds the sandbox service beside it.
    expect(find(renderCombined(), 'Deployment', 'moca-supervisor').spec.replicas).toBe(1);
  });

  it('every object lands in the overlay namespace, the reused component included', () => {
    for (const o of renderCombined()) {
      if (o.kind === 'Namespace' || !o.metadata.namespace) continue;
      expect(o.metadata.namespace, `${id(o)} is not in ${NS}`).toBe(NS);
    }
  });

  it('reuses ocp-sbx/exec-tls: the relay gains the exec sidecar, Service and passthrough Route', () => {
    const objs = renderCombined();
    // The patch comes from a component declaring the BASE namespace. If kustomize stopped matching
    // it, the sidecar would silently vanish and the Route would have no backend.
    const tls = container(find(objs, 'Deployment', 'sandbox-relay'), 'tls-exec');
    expect(tls.args).toContain('--alpn'); // a gRPC client refuses a handshake with no ALPN
    expect(tls.args).toContain('h2');
    expect(tls.image).toMatch(/^docker\.io\/ghostunnel\/ghostunnel:.*@sha256:/); // pinned by digest
    expect(podSpec(find(objs, 'Deployment', 'sandbox-relay')).volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          secret: expect.objectContaining({ secretName: 'sbx-exec-tls' }),
        }),
      ]),
    );
    expect(find(objs, 'Service', 'sbx-relay-exec-tls').spec.selector).toEqual({
      app: 'sandbox-relay',
    });
    // Passthrough, so HTTP/2 and gRPC trailers survive the router.
    expect(find(objs, 'Route', 'sbx-exec').spec.tls.termination).toBe('passthrough');
  });

  it('adds a worker whose id a template may legally name', () => {
    const w = find(renderCombined(), 'Deployment', 'sbx-worker');
    const env = container(w, 'sandbox');
    // A LITERAL, not fieldRef metadata.name: a pod name is dashed and WORKER_RE
    // (/^[A-Za-z_][A-Za-z0-9_]*$/) refuses it, so no template could name the worker.
    expect(envVar(env, 'SANDBOX_ID')).toEqual({ name: 'SANDBOX_ID', value: 'sbx_default' });
    expect(envVar(env, 'SANDBOX_TIER')?.value).toBe('container');
    expect(w.spec.template.metadata.labels.app).toBe('sbx-worker');
  });

  it('opens both directions of the worker attach, not just the worker egress', () => {
    const objs = renderCombined();
    // base/sandbox.yaml's relay policy admits 9443 from `app: moca-sandbox` only, and this worker
    // is `app: sbx-worker`. Under default-deny a missing rule is a TIMEOUT, which reads as a broken
    // relay -- so the ingress half is asserted explicitly.
    const attach = find(objs, 'NetworkPolicy', 'sbx-relay-attach-from-worker');
    expect(attach.spec.podSelector.matchLabels).toEqual({ app: 'sandbox-relay' });
    expect(attach.spec.ingress[0].from[0].podSelector.matchLabels).toEqual({ app: 'sbx-worker' });
    expect(attach.spec.ingress[0].ports[0].port).toBe(9443);
    const egress = find(objs, 'NetworkPolicy', 'sbx-worker');
    expect(
      egress.spec.egress.flatMap((e: { ports?: { port: number }[] }) => e.ports ?? []),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ port: 9443 })]));
    // openshift-dns answers on 5353, not 53.
    expect(
      find(objs, 'NetworkPolicy', 'sbx-worker-dns').spec.egress[0].ports.map(
        (p: { port: number }) => p.port,
      ),
    ).toContain(5353);
  });

  it('gives the control plane the sandbox settings and keeps its credential store', () => {
    const cp = container(
      find(renderCombined(), 'Deployment', 'moca-control-plane'),
      'control-plane',
    );
    for (const key of [
      'SH_ALLOWED_SUBJECTS',
      'SH_SANDBOX_TEMPLATES',
      'SH_SANDBOX_EXEC_ENDPOINT',
      'SH_SANDBOX_TOKEN_ISSUER',
      'SH_SANDBOX_TEST_USERS_ENROLLED',
    ]) {
      const e = envVar(cp, key);
      expect(e?.valueFrom, `${key} does not come from a ConfigMap`).toMatchObject({
        configMapKeyRef: { name: 'sbx-settings' },
      });
    }
    expect(envVar(cp, 'SH_ROUTE_PROFILE')?.value).toBe('combined');
    // A key the installer writes only when the operator asked for it must be optional, or a stack
    // without it crashloops on a missing ConfigMap key instead of defaulting off.
    expect(envVar(cp, 'SH_SANDBOX_TEST_USERS_ENROLLED')?.valueFrom).toMatchObject({
      configMapKeyRef: { optional: true },
    });
    // NOT switched to the file store: ocp-combined does that only because it shares a namespace
    // with an SBX0 stack, and switching here would strand this stack's existing credentials.
    expect(envVar(cp, 'SH_CREDENTIAL_STORE')?.value).toBe('kubernetes');
  });

  it('lets the relay verify sandbox tokens while the harness path keeps working', () => {
    const relay = container(find(renderCombined(), 'Deployment', 'sandbox-relay'), 'sandbox-relay');
    expect(envVar(relay, 'SH_SANDBOX_TOKEN_PUBLIC_KEYS')?.valueFrom).toMatchObject({
      secretKeyRef: { name: 'sbx-token-keys' },
    });
    // Additive: the harness's own exec token must survive the patch.
    expect(envVar(relay, 'MOCA_RELAY_EXEC_TOKEN')).toBeDefined();
  });
});
