---
sidebar_position: 3
---

# Offer templates to every user

> **Preview.** Deployment templates, the template store and its policy are implemented but not yet
> declared Stable; interfaces and limits may change. Known limits:
> [Limits operators must know](runbook.md#9-limits-operators-must-know).

A template every user of the sandbox service can create sandboxes from comes one of two ways: the
deployment declares it in its own settings, or it is a template in the **template store** with
`deployment` visibility. This page says which to choose, and the short version of each.
[The runbook's §5](runbook.md#5-adding-updating-and-removing-a-template) and
[The template host agent](runbook.md#the-template-host-agent) are the full procedures; what users do
is [Make a template from a container image](../../sandbox/how-to/template-from-image.md).

## Which way

| Your deployment                                            | Use                                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| No template store (`SBX_TEMPLATE_STORE` unset or `0`)      | [declared templates](#declared-templates): the only way                                 |
| A template store (`SBX_TEMPLATE_STORE=1`) with host agents | [deployment-visible templates in the store](#deployment-visible-templates-in-the-store) |
| A template store, before the control plane's first start   | either: the declared list is imported into the store once, at that start                |

**The declared list is read into the store once.** With `SBX_TEMPLATE_STORE=1`,
`SBX_TEMPLATES_FILE` is imported into the empty store at the control plane's first start, and
ignored after that: a later change to it only logs a warning that the list differs from the
catalog. On a deployment with a store, add new templates
through the store.

## Declared templates

A declared template is an entry in `SBX_TEMPLATES_FILE`, served by one worker listed in
`SBX_WORKERS`, both in the env file `setup.sh` reads ([the install reference](install.md)). It has
no owner, it is visible to everyone, and it needs no activation: its worker is the deployment's to
run, always on. The short version, from a container image:

1. On the KVM host, `deploy/sbx/template-onboarding/template-build.sh SPEC --kernel PATH` builds the
   snapshot, checks it in a microVM, and writes a template record.
2. On your machine, `deploy/sbx/template-onboarding/template-register.sh --env-file FILE RECORD`
   adds the record's worker to `SBX_WORKERS` and its entry to the templates file.
3. Re-run `setup.sh`: it mints the worker's relay token and writes its bundle. It rolls the control
   plane, not the relay.
4. On the KVM host, `install-host.sh BUNDLE --snapshot <snapshot>` installs the worker, which
   attaches to the relay (`--budget-mb N` for a guest larger than 256 MiB, `--no-egress` for a
   template with no network).
5. Check it with `deploy/sbx/templates-check.sh`
   ([the runbook's §14](runbook.md#14-checking-the-templates)).

An update is a new worker for the new snapshot; the old one stays until its sandboxes end. Steps,
updates and removal: [the runbook's §5](runbook.md#5-adding-updating-and-removing-a-template), and
the onboarding guide's [§4](../../../deploy/sbx/template-onboarding/GUIDE.md#4-example-1-mocas-public-sandbox-image)
for a worked example.

## Deployment-visible templates in the store

On a deployment with the template store and host agents, a template created through
`POST /v1/templates` (`mocactl sbx templates create`) is visible to every user unless it was created
`private`: **`deployment` is the default visibility.** So a template for everyone is created like
any other, by you or by a user, and [the user page](../../sandbox/how-to/template-from-image.md)
is the procedure. A host agent builds and probes it, and the control plane registers it by policy.

**You still install each build's worker once.** The host agent builds templates, and starts and
stops installed workers, but installs none: until a worker is installed, an activation on that host
is reported `refused` (`worker not installed`) and never becomes active. For a
registered build: add its worker id (`sbx_<id with - as _>_<first 12 hex of the image digest>`) to
`SBX_WORKERS`, re-run `setup.sh` for its relay token, and run `install-host.sh` with that bundle
and `--snapshot <snapshot>` on the host that built it
([The template host agent](runbook.md#the-template-host-agent)).

**A host-built template's worker runs only under an activation lease.** Anyone who can see the template
takes or renews one with `mocactl sbx templates activate ID`, or by creating a sandbox on it, which
takes one and answers `409 template_not_active` with `Retry-After`. A lease lasts 60 to 86400 s and
is renewed by activating again, without limit; it counts against the activating user's `active`
quota. There is no setting that keeps a host-built template always running. To keep a released worker
warm for a while, set the host's idle grace, `SBX_IDLE_GRACE_S` in `host-agent.env` (default 0,
off); see [the runbook's idle grace](runbook.md#the-template-host-agent).

### What an admin controls

The stored policy (`GET /v1/policy`, `mocactl sbx policy`) gates every create. An admin changes it
with `PUT /v1/policy`, the whole policy as read plus the change, sent with `?expect=` the digest it
was read with ([Writing the policy](runbook.md#5-adding-updating-and-removing-a-template)). A write
that **widens** the policy is refused `403 forbidden` unless the admin is named in
`SBX_ADMIN_SUBJECTS`.

- **Profiles.** The default policy has `base` (no gate record; up to 16384 MiB and 8 vCPUs),
  `benchmark`, and the self-attested `general-self` and `benchmark-self`. The policy is stored at
  its first read, so a newer image's default profiles reach a running deployment only through a
  `PUT /v1/policy`.
- **Allowed registries.** The default allows only `<default>`, the KVM host's own registry
  (`SBX_REGISTRY`). Add the registries users may bring images from to `allowedRegistries` (Docker
  Hub is `docker.io`), and narrow one to named repositories with `allowedRepositories`.
- **Quotas.** The default is 100 `templates`, 10 `buildsQueued`, 8 `active` and 200 `owned` per
  user. Set one user's with `mocactl sbx templates quota TARGET …`
  ([the Template API's quotas](../../sandbox/reference/templates-api.md#quotas)).
- **Trusted gate records.** A template built on `general-self` or `benchmark-self` with its owner's
  own gate record is self-attested: private, and `deployment` visibility is refused
  `409 self_attested`. To let it be shared, add the record's sha256 (`sha256:<64 hex>` of its exact
  bytes) to `trustedGateRecords`: its builds then read `attestation: deployment`, and the owner can
  make the template `deployment`-visible. Removing the sha256 makes those templates private again
  at the next read; the `PUT /v1/policy` answer lists them as `narrowed`.
- **Withdrawing a template from everyone.** The owner or an admin can make it private
  (`mocactl sbx templates edit ID --visibility private`) or retire it
  (`mocactl sbx templates retire ID`). An admin can also reject a registered build after the fact,
  `POST /v1/templates/{id}/builds/{build}/reject` with `{reason}`; it has no `mocactl` command and
  cannot be undone. A retire or reject is refused `409 build_in_use` while a sandbox runs on the
  build or a session is pinned to it.

The trust rules in full (one subject per self-attested record, `X12.self`, `X1.self.egress`) are in
[Trusting a gate record](runbook.md#5-adding-updating-and-removing-a-template).

## How users see and use it

- `mocactl sbx templates ls` lists the templates a user can see: declared ones, deployment-visible
  ones, and their own private ones, each with its readiness and tags.
- `mocactl sbx create --template ID` (or `sbx up --template ID`) uses the build the template's
  **`default`** tag names. A template's first registered build takes `default`, and later builds do
  not move it until the owner does (`mocactl sbx templates tag ID default --build BUILD`). `ID:TAG`
  and `ID@BUILD` name another build. Without `--template`, `mocactl` asks for the template whose id
  is `default`.
- On a host-built template that is not active, the first create takes a lease and waits for the worker
  ([Templates, builds and activation](../../sandbox/concepts/templates.md)).
