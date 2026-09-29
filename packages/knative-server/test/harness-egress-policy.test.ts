// Manifest-shape test for the harness egress NetworkPolicy (issue #66, Z2 lock-down §4 L3).
//
// NetworkPolicy is CNI-enforced, and the local Kind CNI (kindnet) does NOT enforce it,
// so live egress-blocking can only be observed on a policy-enforcing CNI (OCP OVN-K) —
// that check is the OCP verification gate in the Z2 spec, not this test. Here we assert
// the *shape* of the static manifest (default-deny egress + the {DNS, Redis, HTTPS}
// allowlist) and that both kustomizations wire it in. Pure file parsing: no cluster,
// no kustomize binary, runs in the existing `pnpm -r test` CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEPLOY = resolve(REPO_ROOT, 'deploy/knative');
const POLICY_PATH = resolve(DEPLOY, 'harness-egress-policy.yaml');

function readYaml(path: string): any {
  return parse(readFileSync(path, 'utf8'));
}

/** Collect NetworkPolicy docs from a (possibly multi-doc) manifest file. */
function networkPolicies(path: string): any[] {
  return parseAllDocuments(readFileSync(path, 'utf8'))
    .map((d) => d.toJS())
    .filter((o) => o && o.kind === 'NetworkPolicy');
}

describe('harness egress NetworkPolicy manifest', () => {
  const policies = networkPolicies(POLICY_PATH);

  it('defines exactly one NetworkPolicy', () => {
    expect(policies).toHaveLength(1);
  });

  const np = policies[0] ?? {};

  it('selects the Knative harness pods', () => {
    // Knative stamps this label on the user pod; the policy must target it, not
    // an arbitrary app= label the Knative pod does not carry.
    expect(np.spec?.podSelector?.matchLabels).toMatchObject({
      'serving.knative.dev/service': 'moca',
    });
  });

  it('is egress-only (leaves ingress untouched for the Knative activator)', () => {
    expect(np.spec?.policyTypes).toEqual(['Egress']);
  });

  it('is default-deny: a finite egress allowlist with no catch-all rule', () => {
    const egress = np.spec?.egress ?? [];
    expect(egress.length).toBeGreaterThan(0);
    // A catch-all {} rule (allow all egress) would defeat default-deny. Reject any
    // rule that specifies neither a destination (`to`) nor a port restriction.
    const catchAll = egress.filter(
      (r: any) => (!r.to || r.to.length === 0) && (!r.ports || r.ports.length === 0),
    );
    expect(catchAll).toEqual([]);
  });

  it('allows DNS resolution (UDP+TCP 5353 to openshift-dns — OVN-K enforces post-DNAT, issue #102)', () => {
    // OVN-Kubernetes enforces egress against the POST-DNAT packet: the dns-default
    // Service (:53) DNATs to the CoreDNS pods on their real container port 5353, so a
    // `port: 53` rule never matches and DNS times out. The rule must allow 5353 and be
    // scoped to the openshift-dns namespace.
    const egress = np.spec?.egress ?? [];
    const dnsRule = egress.find((r: any) =>
      (r.to ?? []).some(
        (peer: any) =>
          peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'openshift-dns',
      ),
    );
    expect(dnsRule, 'a rule scoped to the openshift-dns namespace').toBeDefined();
    const protos = new Set(
      (dnsRule.ports ?? []).filter((p: any) => p.port === 5353).map((p: any) => p.protocol),
    );
    expect(protos.has('UDP')).toBe(true);
    expect(protos.has('TCP')).toBe(true);
  });

  it('allows DNS resolution (UDP+TCP 53 to kube-system — Kind/vanilla CoreDNS, modern kindnet enforces)', () => {
    // Modern kindnet enforces egress. Kind's CoreDNS runs in kube-system on the standard
    // port 53 (no post-DNAT remap as on OVN-K), so without this rule DNS is blocked on
    // Kind and the harness cannot resolve authbridge-ab1/redis (every LLM call then fails
    // with "Connection timeout"). The rule must allow 53 scoped to the kube-system namespace.
    const egress = np.spec?.egress ?? [];
    const dnsRule = egress.find((r: any) =>
      (r.to ?? []).some(
        (peer: any) =>
          peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'kube-system',
      ),
    );
    expect(dnsRule, 'a rule scoped to the kube-system namespace').toBeDefined();
    const protos = new Set(
      (dnsRule.ports ?? []).filter((p: any) => p.port === 53).map((p: any) => p.protocol),
    );
    expect(protos.has('UDP')).toBe(true);
    expect(protos.has('TCP')).toBe(true);
  });

  it('allows Redis egress scoped to the redis pod on 6379', () => {
    const egress = np.spec?.egress ?? [];
    const redisRule = egress.find((r: any) => (r.ports ?? []).some((p: any) => p.port === 6379));
    expect(redisRule, 'a rule allowing 6379').toBeDefined();
    // Scoped to the in-cluster redis pod by label — not a broad ipBlock.
    const selectsRedisPod = (redisRule.to ?? []).some(
      (peer: any) => peer.podSelector?.matchLabels?.app === 'redis',
    );
    expect(selectsRedisPod, '6379 rule targets podSelector app=redis').toBe(true);
  });

  it('allows outbound HTTPS on 443 + 6443 to 0.0.0.0/0 (external LLM + in-cluster K8s API — the M8 seam)', () => {
    const egress = np.spec?.egress ?? [];
    const httpsRule = egress.find((r: any) => (r.ports ?? []).some((p: any) => p.port === 443));
    expect(httpsRule, 'a rule allowing 443').toBeDefined();
    const ports = new Set((httpsRule.ports ?? []).map((p: any) => p.port));
    // 443 (external LLM + the kubernetes.default :443 ClusterIP) AND 6443 (the apiserver
    // endpoint reached by kube-proxy DNAT from that ClusterIP) — lock in the documented pair.
    expect(ports.has(443)).toBe(true);
    expect(ports.has(6443)).toBe(true);
    expect((httpsRule.ports ?? []).every((p: any) => (p.protocol ?? 'TCP') === 'TCP')).toBe(true);
    // The external hop today is the M8 seam: this rule targets 0.0.0.0/0, not an in-cluster
    // peer. When the injector lands it narrows to the injector's pinned ClusterIP.
    const targetsAllExternal = (httpsRule.to ?? []).some(
      (peer: any) => peer.ipBlock?.cidr === '0.0.0.0/0',
    );
    expect(targetsAllExternal, 'HTTPS rule targets ipBlock 0.0.0.0/0').toBe(true);
  });

  it("does NOT open the git-daemon port (9418) — gitd is the sandbox's peer, not the harness's", () => {
    const egress = np.spec?.egress ?? [];
    const gitdPorts = egress.flatMap((r: any) => r.ports ?? []).filter((p: any) => p.port === 9418);
    expect(gitdPorts).toEqual([]);
  });
});

describe('tightened AB1 egress variant', () => {
  const AB1_POLICY_PATH = resolve(DEPLOY, 'authbridge/harness-egress-ab1.yaml');
  const policies = networkPolicies(AB1_POLICY_PATH);

  it('defines exactly one NetworkPolicy named moca-egress', () => {
    expect(policies).toHaveLength(1);
    expect(policies[0]?.metadata?.name).toBe('moca-egress');
  });

  const np = policies[0] ?? {};

  it('selects the same Knative harness pods as the base policy', () => {
    expect(np.spec?.podSelector?.matchLabels).toMatchObject({
      'serving.knative.dev/service': 'moca',
    });
  });

  it('is egress-only', () => {
    expect(np.spec?.policyTypes).toEqual(['Egress']);
  });

  it('allows egress to AB1 on TCP 8080', () => {
    const egress = np.spec?.egress ?? [];
    const ab1Rule = egress.find((r: any) =>
      (r.to ?? []).some((peer: any) => peer.podSelector?.matchLabels?.app === 'authbridge-ab1'),
    );
    expect(ab1Rule, 'a rule targeting podSelector app=authbridge-ab1').toBeDefined();
    const hasPort8080 = (ab1Rule.ports ?? []).some(
      (p: any) => p.protocol === 'TCP' && p.port === 8080,
    );
    expect(hasPort8080, 'AB1 rule allows TCP 8080').toBe(true);
  });

  it('does NOT open public :443 egress (the whole point of the tightened variant)', () => {
    const egress = np.spec?.egress ?? [];
    const opensPublic443 = egress.some(
      (r: any) =>
        (r.to ?? []).some((peer: any) => peer.ipBlock?.cidr === '0.0.0.0/0') &&
        (r.ports ?? []).some((p: any) => p.port === 443),
    );
    expect(opensPublic443, 'no rule combining ipBlock 0.0.0.0/0 with port 443').toBe(false);
  });

  it('allows DNS resolution (UDP+TCP 5353 to openshift-dns — OVN-K enforces post-DNAT, issue #102)', () => {
    const egress = np.spec?.egress ?? [];
    const dnsRule = egress.find((r: any) =>
      (r.to ?? []).some(
        (peer: any) =>
          peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'openshift-dns',
      ),
    );
    expect(dnsRule, 'a rule scoped to the openshift-dns namespace').toBeDefined();
    const protos = new Set(
      (dnsRule.ports ?? []).filter((p: any) => p.port === 5353).map((p: any) => p.protocol),
    );
    expect(protos.has('UDP')).toBe(true);
    expect(protos.has('TCP')).toBe(true);
  });

  it('allows DNS resolution (UDP+TCP 53 to kube-system — Kind/vanilla CoreDNS, modern kindnet enforces)', () => {
    // Modern kindnet enforces egress. Kind's CoreDNS runs in kube-system on the standard
    // port 53 (no post-DNAT remap as on OVN-K), so without this rule DNS is blocked on
    // Kind and the harness cannot resolve authbridge-ab1/redis (every LLM call then fails
    // with "Connection timeout"). The rule must allow 53 scoped to the kube-system namespace.
    const egress = np.spec?.egress ?? [];
    const dnsRule = egress.find((r: any) =>
      (r.to ?? []).some(
        (peer: any) =>
          peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'kube-system',
      ),
    );
    expect(dnsRule, 'a rule scoped to the kube-system namespace').toBeDefined();
    const protos = new Set(
      (dnsRule.ports ?? []).filter((p: any) => p.port === 53).map((p: any) => p.protocol),
    );
    expect(protos.has('UDP')).toBe(true);
    expect(protos.has('TCP')).toBe(true);
  });

  it('allows the apiserver / sandbox control channel on 6443', () => {
    const egress = np.spec?.egress ?? [];
    const apiserverRule = egress.find((r: any) =>
      (r.ports ?? []).some((p: any) => p.port === 6443),
    );
    expect(apiserverRule, 'a rule allowing 6443').toBeDefined();
    const targetsAllExternal = (apiserverRule.to ?? []).some(
      (peer: any) => peer.ipBlock?.cidr === '0.0.0.0/0',
    );
    expect(targetsAllExternal, '6443 rule targets ipBlock 0.0.0.0/0').toBe(true);
  });
});

describe('kustomizations wire in the egress policy', () => {
  for (const rel of ['kustomization.yaml', 'overlays/ocp/kustomization.yaml']) {
    it(`${rel} lists harness-egress-policy.yaml in resources`, () => {
      const k = readYaml(resolve(DEPLOY, rel));
      const resources: string[] = k.resources ?? [];
      // base references it bare; the OCP overlay references it via ../../ prefix.
      const referenced = resources.some((r) => r.endsWith('harness-egress-policy.yaml'));
      expect(referenced).toBe(true);
    });
  }
});

describe('the kind/k8s setup scripts actually apply the egress policy', () => {
  // Being listed in kustomization.yaml's resources is not enough on its own: setup-kind.sh and
  // setup-k8s.sh each apply individual files rather than running `kubectl apply -k`, so a
  // manifest can be correctly wired into the kustomization and STILL never reach a cluster those
  // scripts provision. That gap left every Kind/vanilla-k8s harness pod with no egress policy at
  // all -- until control-plane.yaml's additive, TCP:8080-only policy got applied on top, at which
  // point the harness pod became egress-restricted with no DNS allowance and every /turn credential
  // exchange failed ("the harness is unavailable"). setup-ocp.sh is exempt: it renders its overlay
  // via `kubectl kustomize`, which already resolves harness-egress-policy.yaml through the
  // kustomization checked above.
  for (const rel of ['setup-kind.sh', 'setup-k8s.sh']) {
    it(`${rel} applies harness-egress-policy.yaml`, () => {
      const src = readFileSync(resolve(DEPLOY, rel), 'utf8');
      expect(src).toMatch(/harness-egress-policy\.yaml/);
    });
  }
});
