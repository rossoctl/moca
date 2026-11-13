.PHONY: lint fmt check-links test test-deploy test-deploy-bash32 typecheck

lint:
	pre-commit run --all-files

fmt:
	pnpm exec prettier --write .

# Relative links and in-repo anchors across tracked Markdown. Offline; run in CI by the `docs` job.
check-links:
	python3 scripts/check-doc-links.py

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
	@failed=''; for t in deploy/claude/tests/*.test.sh deploy/microvm/tests/*.test.sh deploy/vm/tests/*.test.sh deploy/compose/tests/*.test.sh deploy/k8s/tests/*.test.sh deploy/sbx/tests/*.test.sh deploy/sbx/template-onboarding/tests/*.test.sh scripts/tests/*.test.sh; do \
		echo "== $$t"; \
		bash "$$t" || failed="$$failed $$t"; \
	done; \
	if [ -n "$$failed" ]; then echo; echo "test-deploy FAILED:$$failed"; exit 1; fi

# The suites above that operators' own interpreter can run, on that interpreter: macOS ships bash
# 3.2.57 as /bin/bash, and `deploy/k8s/setup.sh` is run with it. Everything in CI is bash 5, so a
# 3.2-only regression used to reach main -- slice 2 (#424) shipped `"$${arr[@]}"` on an empty array
# under `set -u`, which breaks every 3.2 run and was caught only in review (#440). Run in CI by the
# `deploy-scripts-bash32` job.
#
# The list is explicit, NOT a glob over the same directories as test-deploy: four of those suites
# use bash 4 constructs on purpose and cannot run here (`declare -A` in deploy/compose/tests/
# images.test.sh, `mapfile` in deploy/sbx/tests/smoke.test.sh and deploy/vm/tests/setup-vm.test.sh).
# Widening this to a glob would make the target fail for reasons that are not regressions. Add a
# suite here once it is 3.2-clean.
#
# These three honour $$BASH rather than PATH's first bash, so /bin/bash below really is what runs
# both them and the scripts they test -- which is the other half of #440.
test-deploy-bash32:
	@v="$$(/bin/bash --version 2>/dev/null | head -1)"; \
	case "$$v" in \
	*"version 3."*) ;; \
	'') echo "skip - no /bin/bash on this host; nothing to check"; exit 0 ;; \
	*) echo "skip - /bin/bash is not 3.x ($$v); this target checks the macOS interpreter"; exit 0 ;; \
	esac; \
	echo "== /bin/bash is $$v"; \
	failed=''; for t in deploy/k8s/tests/setup.test.sh deploy/k8s/tests/smoke.test.sh deploy/microvm/tests/setup-microvm.test.sh; do \
		echo "== $$t"; \
		/bin/bash "$$t" || failed="$$failed $$t"; \
	done; \
	if [ -n "$$failed" ]; then echo; echo "test-deploy-bash32 FAILED:$$failed"; exit 1; fi

# One recursive run, so this target and CI cannot drift apart by editing a list in one of
# them -- which they had, in both directions (#191): config-bundle was checked only here,
# sandbox-relay and ibac-stub only in CI. The package set is now whichever packages declare
# a `typecheck` script, and harness/test/typecheck-coverage.test.ts asserts they all do
# (`pnpm -r` skips a package that does not, silently, and still exits 0).
typecheck:
	pnpm -r typecheck
