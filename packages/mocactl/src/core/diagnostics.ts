import type { ControlPlaneApi, HarnessApi } from '../api/types.js';
import { describeError } from './messages.js';

export interface CheckResult {
  id: number;
  name: string;
  status: 'pass' | 'fail';
  fix?: string;
  /** On a failure, the underlying error; on a pass, what was found (only some checks). */
  detail?: string;
}

export interface DiagnosticsDeps {
  cp: ControlPlaneApi;
  harness: HarnessApi;
  controlPlaneUrl: string;
  /** True when a local --harness-url / SH_HARNESS_URL / config value replaces discovery. */
  harnessOverridden: boolean;
  loggedIn: boolean;
}

export const DIAGNOSTIC_NAMES = [
  'control plane reachable',
  'control plane ready',
  'logged in',
  'inference credential present',
  'harness located',
  'harness reachable',
  'harness trusts this control plane',
] as const;

const MU1_HARNESS_SETTINGS =
  'SH_SESSION_TOKEN_PUBLIC_KEYS (on the VM path, re-run `sudo ./deploy/vm/setup-vm.sh`: it installs the control plane and wires the harness)';

/** Spec §6.9: dependency-ordered checks, each failure ending in one line saying what to do. */
export async function runDiagnostics(deps: DiagnosticsDeps): Promise<CheckResult[]> {
  let credential: string | undefined;
  let harnessUrl: string | undefined;
  const checks: Array<{
    run: () => Promise<string | void>;
    fix: string | ((err: unknown) => string);
  }> = [
    {
      run: () => deps.cp.healthz(),
      fix: `cannot reach the control plane at ${deps.controlPlaneUrl} — check --control-plane-url`,
    },
    {
      run: () => deps.cp.readyz(),
      fix: 'the control plane is up but its session store (Redis) is down',
    },
    {
      run: async () => {
        if (!deps.loggedIn) throw new Error('no cached login');
        await deps.cp.me();
      },
      fix: 'not logged in — run `mocactl login`, or start `mocactl` to log in',
    },
    {
      run: async () => {
        credential = (await deps.cp.listCredentials()).find(
          (c) => c.consumer === 'inference',
        )?.name;
        if (!credential) throw new Error('no credential with consumer "inference"');
      },
      fix: 'no inference credential — add one with /credentials',
    },
    {
      run: async () => {
        harnessUrl = await deps.harness.baseUrl();
        return `${harnessUrl} (${deps.harnessOverridden ? 'local override' : 'advertised by the control plane'})`;
      },
      // Discovery's own errors already name their fix (the operator's setting, or the override).
      fix: (err) => describeError(err),
    },
    {
      // health() now also reports the harness's version; /doctor only cares that it answered.
      run: async () => {
        await deps.harness.health();
      },
      fix: () =>
        `cannot reach the harness at ${harnessUrl} — ` +
        (deps.harnessOverridden
          ? 'check --harness-url'
          : 'check SH_PUBLIC_HARNESS_URL on the control plane, or pass --harness-url'),
    },
    {
      // A scratch session, because a session token must name one. The probe never runs a model
      // turn (HarnessClient.probeTrust), and the session is deleted whatever happens.
      run: async () => {
        const s = await deps.cp.createSession({ credentials: { inference: credential } });
        try {
          if ((await deps.harness.probeTrust(s.token, s.sessionId)) === 'untrusted') {
            throw new Error('the harness rejected a valid session token');
          }
        } finally {
          await deps.cp.deleteSession(s.sessionId).catch(() => undefined);
        }
      },
      fix: `the harness does not trust this control plane's tokens — it needs ${MU1_HARNESS_SETTINGS}`,
    },
  ];

  const results: CheckResult[] = [];
  for (const [i, check] of checks.entries()) {
    const base = { id: i + 1, name: DIAGNOSTIC_NAMES[i] };
    try {
      const found = await check.run();
      results.push(
        found ? { ...base, status: 'pass', detail: found } : { ...base, status: 'pass' },
      );
    } catch (err) {
      results.push({
        ...base,
        status: 'fail',
        fix: typeof check.fix === 'string' ? check.fix : check.fix(err),
        detail: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }
  return results;
}

export function formatDiagnostics(results: CheckResult[]): string {
  return results
    .map((r) =>
      r.status === 'pass'
        ? `✓ ${r.id} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`
        : `✗ ${r.id} ${r.name} — ${r.fix}`,
    )
    .join('\n');
}
