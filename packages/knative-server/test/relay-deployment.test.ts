import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';

type EnvVar = { name: string; value?: string };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEPLOY = resolve(REPO_ROOT, 'deploy/knative');
const docs = () =>
  parseAllDocuments(readFileSync(resolve(DEPLOY, 'relay-deployment.yaml'), 'utf8')).map((d) =>
    d.toJS(),
  );

describe('relay-deployment.yaml', () => {
  it('is a single-replica Deployment plus a Service', () => {
    const all = docs();
    const dep = all.find((o) => o.kind === 'Deployment');
    const svc = all.find((o) => o.kind === 'Service');
    expect(dep?.spec.replicas).toBe(1);
    expect(dep?.metadata.name).toBe('sandbox-relay');
    expect(dep?.spec.template.metadata.labels.app).toBe('sandbox-relay');
    expect(svc?.spec.selector.app).toBe('sandbox-relay');
  });

  it('runs the relay entrypoint from its package dir so tsx + deps resolve (issue #102 follow-up)', () => {
    const dep = docs().find((o) => o.kind === 'Deployment');
    const c = dep.spec.template.spec.containers[0];
    expect(c.image).toContain('moca');
    // `node --import tsx` resolves the tsx loader relative to the CWD, and the published
    // image links tsx only into packages/sandbox-relay/node_modules (no /app/node_modules
    // hoist). A CWD of /app crashes ERR_MODULE_NOT_FOUND 'tsx'; run from the package dir.
    expect(c.workingDir).toBe('/app/packages/sandbox-relay');
    const cmd = c.command.join(' ');
    expect(cmd).toContain('--import tsx');
    expect(cmd).toContain('src/main.ts');
  });

  it('is referenced by both kustomizations', () => {
    const base = parse(readFileSync(resolve(DEPLOY, 'kustomization.yaml'), 'utf8'));
    const ocp = parse(readFileSync(resolve(DEPLOY, 'overlays/ocp/kustomization.yaml'), 'utf8'));
    expect(base.resources).toContain('relay-deployment.yaml');
    expect(ocp.resources).toContain('../../relay-deployment.yaml');
  });

  it('sets SH_RELAY_TOKEN matching the worker example (relay auth is fail-closed)', () => {
    const c = docs().find((o) => o.kind === 'Deployment').spec.template.spec.containers[0];
    const env: EnvVar[] = c.env;
    const token = env.find((e) => e.name === 'SH_RELAY_TOKEN');
    expect(
      token?.value,
      "relay auth is fail-closed (main.ts's makeDefaultValidateToken): with no SH_RELAY_TOKEN set, every worker Attach is rejected",
    ).toBeTruthy();
    const worker = parse(readFileSync(resolve(DEPLOY, 'worker-example.yaml'), 'utf8'));
    const wEnv: EnvVar[] = worker.spec.template.spec.containers[0].env;
    expect(
      token!.value,
      "SH_RELAY_TOKEN must equal worker-example.yaml's SANDBOX_TOKEN, or the relay rejects every Attach from a worker deployed off that example",
    ).toBe(wEnv.find((e) => e.name === 'SANDBOX_TOKEN')!.value);
  });
});

describe('the OCP overlay patches the relay token away from the base literal (#173)', () => {
  // The base above deliberately keeps a public dev-token: it is applied bare by
  // demo-remote-worker.sh, relay-leaf-smoke.sh and README-worker.md's Step 1, and relay auth is
  // fail-closed, so a base referencing a Secret would turn "Secret not created yet" into "every
  // Attach rejected" on all of those paths. On OCP that same literal is a real credential in the
  // Deployment spec, so the overlay -- and only the overlay -- replaces it.
  const OVERLAY = resolve(DEPLOY, 'overlays/ocp');
  const patch = () => parse(readFileSync(resolve(OVERLAY, 'patch-relay-token.yaml'), 'utf8'));

  it('is wired into the overlay, or it patches nothing at all', () => {
    const k = parse(readFileSync(resolve(OVERLAY, 'kustomization.yaml'), 'utf8'));
    const paths = (k.patches ?? []).map((p: { path?: string }) => p.path);
    expect(paths).toContain('patch-relay-token.yaml');
  });

  it('is applied by every overlay that consumes the relay, not just the one that has it today', () => {
    // Today overlays/ocp is the only overlay listing relay-deployment.yaml. Without this check,
    // the next overlay to add it would inherit the base's dev-token silently -- which is the
    // exact shape of the bug being fixed, one directory over.
    const overlays = readdirSync(resolve(DEPLOY, 'overlays'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(overlays.length, 'found no overlays to check').toBeGreaterThan(0);

    const leaking = overlays.filter((name) => {
      const k = parse(
        readFileSync(resolve(DEPLOY, 'overlays', name, 'kustomization.yaml'), 'utf8'),
      );
      const usesRelay = (k.resources ?? []).some((r: string) =>
        r.endsWith('relay-deployment.yaml'),
      );
      if (!usesRelay) return false;
      return !(k.patches ?? []).some((p: { path?: string }) => p.path === 'patch-relay-token.yaml');
    });
    expect(
      leaking,
      "these overlays deploy the relay with the base's literal dev-token as a live credential",
    ).toEqual([]);
  });

  it('is created by the script that applies this overlay, not only by the worker demo', () => {
    // The patch makes the Secret a HARD requirement of the overlay: without it the relay pod
    // never starts (CreateContainerConfigError), and setup-ocp.sh does not `rollout status`
    // the relay, so that failure is silent. The coupling checks below only pin the overlay
    // against remote-worker/deploy-incluster.sh -- a separate demo script that also needs
    // deploy/sandbox-relay to exist already -- so they cannot see this at all.
    const setup = readFileSync(resolve(DEPLOY, 'setup-ocp.sh'), 'utf8');
    const env: EnvVar[] = patch().spec.template.spec.containers[0].env;
    const ref = (
      env.find((e) => e.name === 'SH_RELAY_TOKEN') as {
        valueFrom?: { secretKeyRef?: { name?: string; key?: string } };
      }
    ).valueFrom!.secretKeyRef!;

    expect(
      setup,
      `setup-ocp.sh renders and applies overlays/ocp, so it must create Secret ${ref.name}`,
    ).toContain(`create secret generic ${ref.name}`);
    expect(
      setup,
      `the Secret must carry key ${ref.key}, which the overlay reads SH_RELAY_TOKEN from`,
    ).toContain(`--from-literal=${ref.key}=`);
  });

  it('replaces the literal with a secretKeyRef instead of leaving both fields set', () => {
    const env: EnvVar[] = patch().spec.template.spec.containers[0].env;
    const token = env.find((e) => e.name === 'SH_RELAY_TOKEN');
    expect(token, 'the patch must target SH_RELAY_TOKEN').toBeDefined();
    // Strategic merge keeps fields it is not told to remove, and the API server rejects an env
    // entry carrying both value and valueFrom -- so the explicit null is what makes this work.
    expect(
      token!.value,
      'value must be null to delete the base literal; omitting it leaves dev-token in place',
    ).toBeNull();
    const ref = (token as { valueFrom?: { secretKeyRef?: { name?: string; key?: string } } })
      .valueFrom?.secretKeyRef;
    expect(ref, 'the token must arrive by secretKeyRef').toBeDefined();

    // Same Secret and key the worker reads its SANDBOX_TOKEN from. That shared key is what keeps
    // the relay's SH_RELAY_TOKEN and the worker's SANDBOX_TOKEN equal, which fail-closed auth
    // requires -- so a rename on either side has to fail here.
    const script = readFileSync(resolve(REPO_ROOT, 'remote-worker/deploy-incluster.sh'), 'utf8');
    const name = /^SECRET_NAME="([^"]+)"$/m.exec(script);
    const key = /^SECRET_KEY="([^"]+)"$/m.exec(script);
    if (!name || !key) {
      throw new Error(
        'could not find SECRET_NAME= / SECRET_KEY= in deploy-incluster.sh -- renamed? This ' +
          'check cannot compare what it cannot extract.',
      );
    }
    expect(ref!.name, 'must match the Secret deploy-incluster.sh creates').toBe(name[1]);
    expect(ref!.key, 'must match the key deploy-incluster.sh puts the token under').toBe(key[1]);
  });
});
