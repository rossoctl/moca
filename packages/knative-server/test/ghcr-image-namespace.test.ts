// Regression guard for the GHCR namespace rename (issue #177).
//
// The publishing org was renamed `kagenti` -> `rossoctl`. GitHub redirects *repository*
// paths after a rename, but GHCR does **not** redirect *package* paths: the packages became
// reachable only at `ghcr.io/rossoctl/...`, and the freed `kagenti` name was subsequently
// claimed by an unrelated org. So every reference to the old namespace is broken in both
// directions — consumers get `403 Forbidden` from the token endpoint (surfacing as
// ImagePullBackOff), and `build.yaml` cannot push to a namespace we no longer own.
//
// Note the package *name* is unaffected by the rename: only the namespace segment (the one
// right after the host) moves, so the third-party AuthBridge image keeps its
// `kagenti-extensions/authbridge` package name under the new namespace and becomes
// `ghcr.io/rossoctl/kagenti-extensions/authbridge` -- the "kagenti-extensions" there is the
// package name, not the org.
//
// This file deliberately never spells the dead namespace out: it is checked against every
// tracked file, including itself, so DEAD_NS below is assembled at runtime.
//
// Pure file parsing plus `git ls-files`, following the same pattern as
// authbridge-manifests.test.ts and ocp-authbridge-overlay.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Built dynamically so this file does not match its own guard.
const DEAD_NS = ['ghcr.io', 'kagenti'].join('/') + '/';
const LIVE_NS = 'ghcr.io/rossoctl/';

/** Tracked, non-binary files, as repo-relative paths. */
function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => !/\.(png|jpg|jpeg|gif|pdf|ico|woff2?|zip|tar|gz|lock)$/i.test(p));
}

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('GHCR image namespace', () => {
  it('has no references to the dead namespace in any tracked file', () => {
    const offenders: string[] = [];
    for (const rel of trackedTextFiles()) {
      let text: string;
      try {
        text = read(rel);
      } catch {
        continue; // submodule entry or unreadable — not our concern
      }
      if (!text.includes(DEAD_NS)) continue;
      for (const [i, line] of text.split('\n').entries()) {
        if (line.includes(DEAD_NS)) offenders.push(`${rel}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('publishes all three images to the live namespace', () => {
    const workflow = read('.github/workflows/build.yaml');
    for (const name of ['moca', 'moca-sandbox', 'moca-echo-target']) {
      expect(workflow).toContain(`image: ${LIVE_NS}${name}`);
    }
  });

  // Secondary defect from #177: these were plain assignments, so `HARNESS_IMAGE=... ./setup-ocp.sh`
  // was silently ignored and only the --image / --sandbox-image flags worked. setup-kind.sh
  // already had the right shape (`SH_IMAGE="${SH_IMAGE:-...}"`); these now match it.
  it.each([
    ['deploy/knative/setup-ocp.sh', 'HARNESS_IMAGE'],
    ['deploy/knative/setup-ocp.sh', 'SANDBOX_IMAGE'],
    ['deploy/knative/setup-k8s.sh', 'HARNESS_IMAGE'],
    ['deploy/knative/setup-k8s.sh', 'SANDBOX_IMAGE'],
  ])('%s honours $%s from the environment', (script, varName) => {
    expect(read(script)).toContain(`${varName}="\${${varName}:-`);
  });

  it('renders the dynamic workload Sandbox image for OpenShift', () => {
    const setup = read('deploy/knative/setup-ocp.sh');
    expect(setup).toContain('-e "s#dev.local/moca-sandbox:local#${SANDBOX_IMAGE}#g"');
    expect(read('deploy/knative/service.yaml')).toContain("value: 'dev.local/moca-sandbox:local'");
  });

  it('loads the dynamic workload Sandbox image for Kind', () => {
    const setup = read('deploy/knative/setup-kind.sh');
    expect(setup).toContain(
      'SANDBOX_IMAGE="${SANDBOX_IMAGE:-ghcr.io/rossoctl/moca-sandbox:latest}"',
    );
    expect(setup).toContain('kind load docker-image "$LOCAL_SANDBOX_IMAGE"');
    expect(setup).toContain('ensure_sandbox_image');
  });
});
