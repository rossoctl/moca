import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_KUBECTL, REPO_ROOT, container, envNames, envVar, find, render } from './render.js';

/**
 * Every variable a VM env template names -- set (`NAME=`) or offered commented (`#NAME=`) -- must be
 * set on the matching container, so the two deployments cannot drift (deploy/compose's
 * compose.test.sh applies the same rule). Prose comments are not assignments and are ignored.
 */
function templateVars(file: string): string[] {
  const text = readFileSync(resolve(REPO_ROOT, 'deploy/vm/env', file), 'utf8');
  return [...text.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
}

/**
 * Differences between the tiers, each with its reason: credential TRANSPORT (how a secret reaches
 * the process, not whether it does), or a value one tier deliberately DERIVES rather than sets.
 */
const NOT_ENV_ON_K8S: Record<string, string> = {
  // (SH_EXCHANGE_TOKEN is not a template line -- it is a systemd credential on the VM and a file
  // under CREDENTIALS_DIRECTORY here; base-supervisor.test.ts pins that.)
  // Deliberately not set: the per-subject cap defaults to half of SH_TURNS_PER_WORKER (#360), so
  // a pinned literal here would drift the moment an operator changes S.
  SH_TURNS_PER_SUBJECT: 'derived (half of SH_TURNS_PER_WORKER), so the manifest does not pin it',
  // SBX0 only: set by overlays/ocp-sbx (the sandbox front door); a MOCA relay has no sandbox callers.
  SH_SANDBOX_TOKEN_PUBLIC_KEYS:
    'SBX0 only: set by overlays/ocp-sbx (the sandbox front door); a MOCA relay has no sandbox callers',
  SH_SANDBOX_TOKEN_ISSUER:
    'SBX0 only: set by overlays/ocp-sbx (the sandbox front door); a MOCA relay has no sandbox callers',
  SH_SANDBOX_MAX_INFLIGHT:
    'SBX0 only: set by overlays/ocp-sbx (the sandbox front door); a MOCA relay has no sandbox callers',
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

  it('the ocp-sbx relay sets the SBX0-only variables the base leaves out', () => {
    const c = container(
      find(render('overlays/ocp-sbx'), 'Deployment', 'sandbox-relay', 'moca-sbx'),
      'sandbox-relay',
    );
    const sbx0Vars = [
      'SH_SANDBOX_TOKEN_PUBLIC_KEYS',
      'SH_SANDBOX_TOKEN_ISSUER',
      'SH_SANDBOX_MAX_INFLIGHT',
    ];
    const names = envNames(c);
    expect(sbx0Vars.every((v) => names.includes(v))).toBe(true);
  });

  it('the control plane and the supervisor read the sandbox tiers from one source (P6.3 spec §7)', () => {
    const sup = container(
      find(render('base'), 'Deployment', 'moca-supervisor', 'moca'),
      'supervisor',
    );
    const cp = container(
      find(render('base'), 'Deployment', 'moca-control-plane', 'moca'),
      'control-plane',
    );
    const supTiers = envVar(sup, 'SH_SANDBOX_TIERS');
    const cpTiers = envVar(cp, 'SH_SANDBOX_TIERS');
    const supDefault = envVar(sup, 'SH_SANDBOX_DEFAULT_TIER');
    const cpDefault = envVar(cp, 'SH_SANDBOX_DEFAULT_TIER');

    expect(supTiers).toBeDefined();
    expect(cpTiers).toBeDefined();
    expect(supTiers).toEqual(cpTiers);
    expect(supDefault).toBeDefined();
    expect(cpDefault).toBeDefined();
    expect(supDefault).toEqual(cpDefault);
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
