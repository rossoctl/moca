import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { K8S_DIR, NO_KUBECTL, render, type K8sObject } from './render.js';

/**
 * #716: the control plane keys unauthenticated login starts by the client's address, which behind
 * an OpenShift Route is the LAST X-Forwarded-For entry (SH_TRUSTED_PROXY_HOPS=1). That trust holds
 * only while the router APPENDS: an IngressController whose forwardedHeaderPolicy is IfNone passes
 * a client's own header through (any address it likes, a victim's included), and Never or Replace
 * change what the last entry means. So every Route that reaches the control plane pins `append`
 * itself, on every overlay, and these tests keep it that way.
 */
const ANNOTATION = 'haproxy.router.openshift.io/set-forwarded-headers';
const DIR = resolve(K8S_DIR, '.generated/test-forwarded-headers');

/** The ocp-single Routes component, rendered as setup.sh's generated overlay lists it. */
function renderOcpSingleRoutes(): K8sObject[] {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    resolve(DIR, 'kustomization.yaml'),
    'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../../overlays/ocp-single\ncomponents:\n  - ../../overlays/ocp-single/routes\nnamespace: moca-single\n',
  );
  const out = execFileSync('kubectl', ['kustomize', DIR], { encoding: 'utf8' });
  return parseAllDocuments(out)
    .map((d) => d.toJS() as K8sObject | null)
    .filter((o): o is K8sObject => o !== null);
}

const controlPlaneRoutes = (objs: K8sObject[]) =>
  objs.filter((o) => o.kind === 'Route' && o.spec.to.name === 'moca-control-plane');

describe.skipIf(NO_KUBECTL)(
  'the control plane trusts X-Forwarded-For only as appended (#716)',
  () => {
    afterAll(() => rmSync(DIR, { recursive: true, force: true }));

    it.each([
      ['overlays/ocp', () => render('overlays/ocp'), ['moca-control-plane']],
      ['overlays/ocp-single + routes', renderOcpSingleRoutes, ['moca-control-plane']],
      ['overlays/ocp-sbx', () => render('overlays/ocp-sbx'), ['sbx-api']],
      ['overlays/ocp-combined', () => render('overlays/ocp-combined'), ['moca-api']],
    ] as const)('%s: every Route to the control plane pins append', (_name, objs, names) => {
      const routes = controlPlaneRoutes(objs());
      // The Routes named are all of them: a new one must be added here, and pin append too.
      expect(routes.map((r) => r.metadata.name).sort()).toEqual([...names]);
      for (const r of routes) expect(r.metadata.annotations?.[ANNOTATION]).toBe('append');
    });
  },
);
