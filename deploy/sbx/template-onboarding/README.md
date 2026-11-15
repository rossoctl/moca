# Moca template onboarding

The all-in-one place for **sandbox templates**: what they are, how to create and onboard one from a
container image, how to check it, and how clients and agents use it. A template is a named image
that a client asks for by id; its commands then run in microVMs restored from that image's snapshot.

Start with the [Template Onboarding Guide](GUIDE.md). It walks through the whole flow with two
sample templates and a client choosing between them.

**Gating, provenance and the process** that govern these tools (which images may become templates,
what each step records): [`governance/`](governance/README.md).

## In this folder

| File                                                                                               | What it is                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`GUIDE.md`](GUIDE.md)                                                                             | the guide: mental model, the flow, two worked examples, self-serve from your own image (§4b), update and retire, capacity, troubleshooting                                                                                                         |
| [`ONBOARDING.md`](ONBOARDING.md)                                                                   | the short reference: the steps, the spec's fields, the tools' options                                                                                                                                                                              |
| [`governance/`](governance/README.md)                                                              | the gating rules, the process, and where each is owned                                                                                                                                                                                             |
| [`template-build.sh`](template-build.sh)                                                           | **KVM host, root:** spec → pull by digest → rootfs → snapshot, the probe run in a restored microVM → a template record                                                                                                                             |
| [`template-register.sh`](template-register.sh)                                                     | **operator machine:** record → `SBX_WORKERS` and the templates file (add, versioned update, `--retire`, `--remove`), then `setup.sh`                                                                                                               |
| [`verify-provenance.py`](verify-provenance.py)                                                     | **anywhere, Python 3 only:** verifies a template provenance export offline (digests, chain, heads, cited gate records); `--head` compares a head kept elsewhere; `--egress SANDBOX_ID=FILE` checks a saved egress log against the sandbox's record |
| [`redact-provenance.py`](redact-provenance.py)                                                     | **the control plane's store, offline (control plane stopped):** redacts text matching a pattern from one template's provenance stream and catalog entry (or `--catalog-only`), re-chaining the later records                                       |
| [`examples/default.json`](examples/default.json)                                                   | sample spec 1: Moca's public sandbox image (`ghcr.io/rossoctl/moca-remote-worker`, pinned), template `default`                                                                                                                                     |
| [`examples/django__django-11133.json`](examples/django__django-11133.json)                         | sample spec 2: a SWE-bench instance (an image builder's spec block, host-free image), template `django-django-11133`                                                                                                                               |
| [`examples/django__django-11133.gate-record.json`](examples/django__django-11133.gate-record.json) | sample 2's gate record, from its image builder with the gate's test results removed, passed with `--gate-record`                                                                                                                                   |
| [`tests/`](tests/)                                                                                 | `template-build.test.sh`, `template-register.test.sh`, and `examples.test.sh` (every sample passes the spec check)                                                                                                                                 |

## Related files elsewhere in the repository

These are part of the same flow but live with the code they belong to.

**SBX0, the sandbox service the templates run on** (`deploy/sbx/`):

| File                                             | Role in the flow                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [`../setup.sh`](../setup.sh)                     | the cluster side: mints each worker's token and bundle; a template change restarts the control plane only               |
| [`../install-host.sh`](../install-host.sh)       | the KVM host: installs (or `--uninstall`s) a template's worker                                                          |
| [`../host-agent.sh`](../host-agent.sh)           | the KVM host's template agent: builds queued templates, starts and stops their workers, removes retired builds          |
| [`../templates-check.sh`](../templates-check.sh) | the live check that a client gets the template it asked for, and that templates are isolated                            |
| [`../README.md`](../README.md)                   | installing SBX0                                                                                                         |
| [`../RUNBOOK.md`](../RUNBOOK.md)                 | operating it: §5 templates, [guest egress](../RUNBOOK.md#guest-egress), the template host agent, checking the templates |
| [`../tests/`](../tests/)                         | the deploy scripts' tests (`install-host.test.sh`, `setup.test.sh`, …)                                                  |

**Snapshots** (`deploy/microvm/`):

| File                                                                 | Role in the flow                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`../../microvm/build-rootfs.sh`](../../microvm/build-rootfs.sh)     | image → rootfs tree (called by `template-build.sh`)                                                                                    |
| [`../../microvm/build-snapshot.sh`](../../microvm/build-snapshot.sh) | rootfs → golden snapshot; `--verify-command` runs the probe (called by `template-build.sh`)                                            |
| [`../../microvm/P4-ON-P6.md`](../../microvm/P4-ON-P6.md)             | building snapshots by hand, and a templated P4 worker for Moca sessions                                                                |
| [`../../microvm/setup-microvm.sh`](../../microvm/setup-microvm.sh)   | Moca-VM (P6+P4): `--template ID --snapshot DIR` installs a templated P4 worker for Moca sessions; `--uninstall-template ID` removes it |

**Using a template:**

| File                                                                                                                                      | Role in the flow                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`docs/sbx/user-guide.md`](../../../docs/sbx/user-guide.md)                                                                               | clients: `mocactl sbx templates`, `create --template`, `run`, agents through `mocactl sbx mcp` |
| [`docs/concepts/sandboxes-and-tiers.md`](../../../docs/concepts/sandboxes-and-tiers.md)                                                   | templates and tiers in Moca's own agent sessions (`--option sandboxTemplate=ID`)               |
| `docs/specs/2026-10-30-session-sandbox-templates-design.md`                                                                               | the design of templates in agent sessions                                                      |
| `docs/specs/2026-11-03-template-lifecycle-and-provenance-design.md`                                                                       | the design of the template lifecycle: self-serve creates, activation, provenance               |
| [`docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md`](../../../docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md) | the design of SBX0 and its templates                                                           |

**Code that implements template selection:** `packages/control-plane/src/sandbox-config.ts`
(`SH_SANDBOX_TEMPLATES`), `packages/control-plane/src/sandbox-handlers.ts` (`POST /v1/sandboxes
{template}`), `harness/src/select-sandbox.ts` (a session's template), and
`remote-worker/internal/session/labels.go` (a worker's `SANDBOX_TEMPLATE`).

## The flow in brief

```bash
# 1. KVM host: build and check (the spec says image, size, egress, seed, probe)
sudo deploy/sbx/template-onboarding/template-build.sh deploy/sbx/template-onboarding/examples/default.json --kernel /path/to/vmlinux

# 2. operator machine: register (with the record copied from the host), then setup.sh
deploy/sbx/template-onboarding/template-register.sh --env-file <env file> default-eed901b838bf.json --apply

# 3. KVM host: install the worker from its bundle
sudo deploy/sbx/install-host.sh <bundle dir> --snapshot default-eed901b838bf --budget-mb 8192

# 4. client: choose it
mocactl sbx templates
mocactl sbx create --template default
```

On a deployment with the template store and host agents, a client does all of this itself through
the API: [GUIDE §4b](GUIDE.md#4b-from-an-oci-image-to-a-moca-template-self-serve).
