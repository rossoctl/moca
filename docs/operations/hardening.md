# Hardening checklist

> **Preview.** A checklist for operators, drawn from the [security model](../reference/security-model.md); read that
> page for the reasons. Items marked _(documented)_ are stated in the deployment READMEs; the rest follow from the
> code. None of this makes mutually distrusting users safe on one deployment: the per-session isolation design (MI1)
> is not built, so give each trust domain its own deployment.

## On every path

- [ ] **Set `SH_REQUIRE_AUTH=true`.** Compose defaults to `false` and the operator's `ANTHROPIC_*` variables then serve
      unauthenticated turns for anyone who can reach port 8080. The VM template and Kubernetes manifest already set
      it. If you must leave it off for a demo, keep the port off any shared network.
- [ ] **Decide the tenancy.** `MOCA_TENANCY=multi` makes the worker refuse local tools, scrub ambient provider
      credentials and require auth. No shipped deployment sets it. The VM README says not to rely on it to separate
      two users _(documented)_.
- [ ] **Keep `SH_ALLOW_OPERATOR_FALLBACK` off** unless a one-key trial needs it. The control plane has no user
      allowlist, so with the fallback on any GitHub user who can reach it can spend the operator's key.
- [ ] **Keep `SH_ADMIN_SUBJECTS` minimal.** Empty means no admins. Admin can list other users' sessions and delete any
      bundle.
- [ ] **Back up the credential KEK ring before anything else.** Losing it makes every stored credential unreadable
      _(documented)_. Setup never rotates it. See [Redis backup and recovery](redis-backup-recovery.md#secrets-to-back-up-separately).
- [ ] **Do not publish** Redis, the supervisor admin port (8081), the relay exec listener or the control plane port to
      networks you do not trust. The admin port is unauthenticated.
- [ ] **Keep the supervisor reachable at layer 4 only.** No Ingress, edge Route or mesh sidecar in front of it.
- [ ] **Pin images by digest.** The harness and remote-worker images are `:latest` by default; pass
      `--image <ref>@sha256:...` (harness) and `--sandbox-image <ref>@sha256:...` (remote worker) to `setup.sh`, or
      `SANDBOX_IMAGE` on the VM. Redis is digest-pinned only on Kubernetes. Images are not signed.
- [ ] **Treat the supervisor-to-control-plane hop as plaintext.** It carries the exchange bearer and session tokens,
      and in direct mode the real model key. Keep it on a network you control.
- [ ] **Rotate tokens deliberately.** Access tokens last 15 minutes and are never revoked, so shorten
      `SH_API_TOKEN_TTL_SECONDS` if you need faster revocation.

## Kubernetes ([`deploy/k8s`](../operate/harness/kubernetes.md))

- [ ] **Use a CNI that enforces NetworkPolicy** (kind 0.24 or later, or OVN-Kubernetes). On one that does not, every
      isolation rule is open _(documented)_. Run the smoke test's isolation claim to check.
- [ ] **Look at your node network.** If it uses publicly routable addresses, the sandbox egress rule does not block
      it; set `SH_SANDBOX_EGRESS_EXCEPT` _(documented, #446)_.
- [ ] **Scope the admin port.** Any pod in `moca` can read the unauthenticated `/metrics`. On the single-namespace
      OpenShift target (`ocp-single`) that includes the **sandbox** pods. Do not run unrelated workloads in that
      namespace, or tighten the policy.
- [ ] **Restrict who can read secrets in `moca`.** All four MU1 values (signing key, public keys, KEK, exchange token) are keys of
      one Secret, `moca-mu1`.
- [ ] **Delete a leftover `moca-genkeys` pod** if `setup.sh` was killed; its log holds the generated keys.
- [ ] **Consider encryption at rest for Secrets.** This repository does not configure it, and per-user credentials
      sit in Secrets (sealed under the KEK, with metadata in plaintext annotations).
- [ ] **Add what the manifests omit:** no ResourceQuota, LimitRange, PID or ephemeral-storage limits, and no
      PodDisruptionBudget.
- [ ] **On OpenShift, supply a real certificate** (`--tls-cert`/`--tls-key`, or `--tls-secret` on the `ocp-single` target only) instead of the
      self-signed fallback, and remember the control plane's Route terminates TLS at the router.

## Single VM ([`deploy/vm`](../operate/harness/single-vm.md))

- [ ] **Restrict access to ports 8080 and 8090.** Use the README's SSH `Match User` block, or a firewall allowlist. An
      allowlist sends tokens in clear. The supervisor binds all interfaces regardless of the sandbox firewall, as does
      the relay attach port (9443); the sandbox firewall restricts only the sandbox bridge.
- [ ] **Close cloud metadata at the platform** (for example IMDSv2 with a hop limit of 1). Container sandboxes can
      currently reach it (#357).
- [ ] **Verify `isolate=strict` is enforced.** Setup refuses a podman that rejects the option but cannot tell one that
      stores it without enforcing it. It was verified on netavark 1.17.2.
- [ ] **Remember the shared user.** The three units run as one account, so a supervisor compromise reads the control
      plane's credentials _(documented)_.
- [ ] **Redis is on loopback with no password and no named volume.**
- [ ] **If you add the microVM tier,** run its worker under a hardened unit; the shipped one runs as root with no
      systemd sandboxing. Keep its relay token separate (the installer does this).

## Docker Compose ([`deploy/compose`](../operate/harness/compose.md))

- [ ] **Treat it as a trial.** Redis has no password, sandboxes have internet access, and there are no resource limits.
- [ ] **Set `SH_REQUIRE_AUTH=true` as soon as you add the control plane**, and remove `ANTHROPIC_*` from `.env` if you
      want no anonymous spend.
- [ ] **Publish ports on loopback only** (the shipped file already does for the supervisor and control plane).

## MicroVM tier ([`deploy/microvm`](../../deploy/microvm/P4-ON-P6.md))

- [ ] **Use it where you need network isolation, not user isolation.** The guest has no network device and reaches only `moca-egress`'s allowlist, but nothing binds a
      workspace key to a user.
- [ ] **Guard the relay exec token.** Whoever holds it can target any workspace.
- [ ] **Never give the microVM worker the exec token.** It uses its own attach token.
- [ ] **Plan for silent workspace resets** (#338) and for `SH_MAX_COMMITTED_MB`, which gates memory but not workspace
      disk.

## Reporting a problem

Report vulnerabilities privately; see [`SECURITY.md`](../../SECURITY.md).
