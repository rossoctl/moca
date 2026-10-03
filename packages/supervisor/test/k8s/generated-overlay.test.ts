import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { K8S_DIR, NO_KUBECTL, find, podSpec, type K8sObject } from './render.js';

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

  it('stamps the settings hash on the control plane pod template', () => {
    const cp = find(objs, 'Deployment', 'moca-control-plane', 'moca');
    expect(cp.spec.template.metadata.annotations['moca.dev/settings-hash']).toBe(HASH);
  });
});
