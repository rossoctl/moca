.PHONY: lint fmt test test-deploy typecheck demo-remote-sandbox demo-remote-sandbox-teardown \
	demo-promoted-workflow demo-promoted-workflow-teardown demo-multiuser demo-multiuser-teardown \
	mocactl-quickstart mocactl-quickstart-teardown

lint:
	pre-commit run --all-files

fmt:
	pnpm exec prettier --write .

test:
	pnpm -r test
	cd remote-worker && go test ./...
	$(MAKE) test-deploy

# Cluster-free unit tests for the deploy/ shell scripts: kubectl, kind and docker are
# mocked on PATH and only the call log is asserted. Run in CI by the `deploy-scripts` job.
# Every suite runs, and any failure still fails the target. `set -e` used to abort the
# loop on the first failing file, which met the "not scrolled past" goal but silently
# skipped every later suite: one red file made the rest look green by never running them.
# Failures are collected instead, so the target's verdict is unchanged while the output
# says which suites failed AND proves the others actually ran.
# deploy/claude/tests covers the /promote slash-command asset, which nothing else type-checks.
# deploy/vm/tests covers setup-vm.sh, the single-VM systemd deployment (podman/systemctl mocked).
# deploy/compose/tests covers the compose trial: install.sh (docker/curl mocked) and the compose file.
# deploy/k8s/tests covers setup.sh, the Kubernetes deployment of P6 (kubectl/kind/docker/oc mocked).
# scripts/tests covers install-mocactl.sh, the mocactl one-line installer (curl/node mocked).
test-deploy:
	@failed=''; for t in deploy/knative/tests/*.test.sh deploy/claude/tests/*.test.sh deploy/microvm/tests/*.test.sh deploy/vm/tests/*.test.sh deploy/compose/tests/*.test.sh deploy/k8s/tests/*.test.sh scripts/tests/*.test.sh; do \
		echo "== $$t"; \
		bash "$$t" || failed="$$failed $$t"; \
	done; \
	if [ -n "$$failed" ]; then echo; echo "test-deploy FAILED:$$failed"; exit 1; fi

# One recursive run, so this target and CI cannot drift apart by editing a list in one of
# them -- which they had, in both directions (#191): config-bundle was checked only here,
# sandbox-relay and ibac-stub only in CI. The package set is now whichever packages declare
# a `typecheck` script, and harness/test/typecheck-coverage.test.ts asserts they all do
# (`pnpm -r` skips a package that does not, silently, and still exits 0).
typecheck:
	pnpm -r typecheck

# Laptop showcase: harness on kind, remote worker as a host container dialing out.
# See deploy/knative/README-worker.md. Add --reuse-cluster to skip setup on a warm cluster.
demo-remote-sandbox:
	bash deploy/knative/demo-remote-worker.sh $(DEMO_ARGS)

demo-remote-sandbox-teardown:
	bash deploy/knative/demo-remote-worker.sh --teardown

# Promote a Claude Code workflow authored in a minimal local sandbox, then prove it ran remotely.
# Needs a warm cluster whose image contains the promotion feature; the script gates on that.
# See docs/demos/promoted-workflow-demo.md.
demo-promoted-workflow:
	bash deploy/knative/demo-promoted-workflow.sh $(DEMO_ARGS)

demo-promoted-workflow-teardown:
	bash deploy/knative/demo-promoted-workflow.sh --teardown

# MU1 multi-user demo: two GitHub logins, owned sessions, per-user credentials, and a credential
# property that holds with the deployment's own key present in the environment. Needs a warm cluster,
# a GitHub OAuth app with device flow enabled, and two GitHub accounts; it SKIPS with a message
# otherwise. See docs/specs/2026-09-08-multi-user-control-plane-design.md §10.
demo-multiuser:
	bash deploy/knative/demo-multiuser.sh $(DEMO_ARGS)

demo-multiuser-teardown:
	bash deploy/knative/demo-multiuser.sh --teardown

# Wire a warm kind cluster for mocactl and hold the port-forwards open, so `mocactl` needs one URL
# (packages/mocactl/QUICKSTART.md). Needs SH_GITHUB_CLIENT_ID: a GitHub OAuth app with device flow on.
mocactl-quickstart:
	bash deploy/knative/mocactl-quickstart.sh $(DEMO_ARGS)

mocactl-quickstart-teardown:
	bash deploy/knative/mocactl-quickstart.sh --teardown
