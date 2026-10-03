import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

// Manifest tests for deploy/k8s (P6.1). They live in this package because `make test` is
// `pnpm -r test` and there is no root vitest config; @moca/supervisor owns the P6 runtime, and
// packages/knative-server/test/relay-deployment.test.ts is the precedent for testing manifests
// from a package.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const K8S_DIR = resolve(REPO_ROOT, 'deploy/k8s');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rendered YAML is untyped by nature
export type K8sObject = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  [k: string]: any;
};
export type Target = 'base' | 'overlays/kind' | 'overlays/kind-ci' | 'overlays/ocp';

export function haveKubectl(): boolean {
  try {
    execFileSync('kubectl', ['version', '--client'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const cache = new Map<Target, K8sObject[]>();
export function render(target: Target): K8sObject[] {
  const hit = cache.get(target);
  if (hit) return hit;
  const out = execFileSync('kubectl', ['kustomize', resolve(K8S_DIR, target)], {
    encoding: 'utf8',
  });
  const objs = parseAllDocuments(out)
    .map((d) => d.toJS() as K8sObject | null)
    .filter((o): o is K8sObject => o !== null);
  cache.set(target, objs);
  return objs;
}

export function find(objs: K8sObject[], kind: string, name: string, namespace?: string): K8sObject {
  const o = objs.find(
    (x) =>
      x.kind === kind &&
      x.metadata.name === name &&
      (namespace === undefined || x.metadata.namespace === namespace),
  );
  if (!o) throw new Error(`no ${kind}/${name}${namespace ? ` in ${namespace}` : ''} in the render`);
  return o;
}

export const podSpec = (o: K8sObject) => o.spec.template.spec;
export function container(o: K8sObject, name: string) {
  const c = podSpec(o).containers.find((x: { name: string }) => x.name === name);
  if (!c) throw new Error(`${o.kind}/${o.metadata.name} has no container ${name}`);
  return c;
}
export const envNames = (c: { env?: { name: string }[] }): string[] =>
  (c.env ?? []).map((e) => e.name);
export const envVar = (
  c: { env?: { name: string; value?: string; valueFrom?: unknown }[] },
  name: string,
): { name: string; value?: string; valueFrom?: unknown } | undefined =>
  (c.env ?? []).find((e) => e.name === name);

/** describe.skipIf reason, printed once so a skip is visible in CI logs rather than silent. */
export const NO_KUBECTL = !haveKubectl();
if (NO_KUBECTL) console.warn('deploy/k8s manifest tests SKIPPED: kubectl is not on PATH');
