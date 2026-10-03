import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_KUBECTL, REPO_ROOT, container, envNames, find, render } from './render.js';

/**
 * Every variable a VM env template names -- set (`NAME=`) or offered commented (`#NAME=`) -- must be
 * set on the matching container, so the two deployments cannot drift (deploy/compose's
 * compose.test.sh applies the same rule). Prose comments are not assignments and are ignored.
 */
function templateVars(file: string): string[] {
  const text = readFileSync(resolve(REPO_ROOT, 'deploy/vm/env', file), 'utf8');
  return [...text.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
}

/** Differences in credential TRANSPORT, not in what the process receives. Each one says why. */
const NOT_ENV_ON_K8S: Record<string, string> = {
  // (none today: SH_EXCHANGE_TOKEN is not a template line -- it is a systemd credential on the VM and
  // a file under CREDENTIALS_DIRECTORY here; base-supervisor.test.ts pins that.)
};

describe.skipIf(NO_KUBECTL)('deploy/k8s env parity with deploy/vm/env', () => {
  it('sets every supervisor.env.example variable on the supervisor container', () => {
    const c = container(
      find(render('base'), 'Deployment', 'moca-supervisor', 'moca'),
      'supervisor',
    );
    const missing = templateVars('supervisor.env.example').filter(
      (v) => !(v in NOT_ENV_ON_K8S) && !envNames(c).includes(v),
    );
    expect(missing).toEqual([]);
  });

  it('sets every relay.env.example variable on the relay container', () => {
    const c = container(
      find(render('base'), 'Deployment', 'sandbox-relay', 'moca'),
      'sandbox-relay',
    );
    const missing = templateVars('relay.env.example').filter(
      (v) => !(v in NOT_ENV_ON_K8S) && !envNames(c).includes(v),
    );
    expect(missing).toEqual([]);
  });

  it('parses the templates it claims to (a guard against a regex that matches nothing)', () => {
    expect(templateVars('supervisor.env.example')).toEqual(
      expect.arrayContaining(['SH_TURNS_PER_WORKER', 'SH_ADMIN_HOST', 'SH_RELAY_ADDR']),
    );
    expect(templateVars('relay.env.example')).toEqual(
      expect.arrayContaining(['SH_RELAY_PORT', 'MOCA_RELAY_EXEC_ADDR', 'SH_RELAY_TOKEN']),
    );
  });
});
