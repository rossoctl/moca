---
sidebar_position: 7.5
---

# Make a template from a container image

> **Preview.** Self-serve templates are implemented but not yet declared Stable; interfaces
> and limits may change. Known limits: [Limits](../concepts/limits.md).

You have a container image with the tools you want, and you want sandboxes that start from it.
This page takes you from that image to a working **template**, one step at a time, with one worked
example: `python:3.12-slim`. Nobody approves it: the deployment's policy admits or refuses your
template, and a KVM host builds it and checks it in a real microVM.

The long form, with the reasoning and the runs it comes from, is
[the template onboarding guide, §4b](../../../deploy/sbx/template-onboarding/GUIDE.md#4b-from-an-oci-image-to-a-moca-template-self-serve).
What a template, a build and a tag are is in
[Templates, builds and activation](../concepts/templates.md).

## 1. What you need

- **A login** to the sandbox service as an enrolled user, and `mocactl`
  ([Install, log in and bring a repository up](set-up.md)).
- **A deployment with a template store.** Without one, `mocactl sbx policy` answers
  `400 invalid_request`: you can use the templates your operator provides, but not make your own.
- **A registry the policy allows**, to push your image to. See what yours allows:

  ```bash
  mocactl sbx policy
  ```

  The `registries` line lists them. `<default>` is your operator's own registry: an image written
  with no registry host (`team/image@sha256:…`) is pulled from it. Write a Docker Hub image with its
  host, `docker.io/library/python@sha256:…`. Only listed registries are accepted (rule `registry`).
  A registry may also admit only some repositories (rule `registry.repository`); ask an admin if
  yours is not among them.

- **Room in your quota.** It shows each quota, and how much of it you use:

  ```bash
  mocactl sbx quota
  ```

  A new template needs a free `templates` slot and a free `buildsQueued` slot. Activating it later
  takes an `active` slot. The defaults are in the
  [Template API's quota table](../reference/templates-api.md#quotas).

Your image must be pinned by digest in the spec: `repository@sha256:<64 hex>`, never a tag.

## 2. Pick a profile

The **profile** you name is the gate your template must pass. `mocactl sbx policy` lists the ones
your deployment has, each with its size limits and whether it allows egress.

| You want                                              | Profile                          | You bring                                       |
| ----------------------------------------------------- | -------------------------------- | ----------------------------------------------- |
| A toolchain or an app, available quickly              | `base` (the default)             | the image and a spec                            |
| moca to hold the template to a test result you proved | `general-self`, `benchmark-self` | a gate record too, from an image builder's gate |
| A benchmark image your deployment curates             | `benchmark`                      | a gate record an admin already trusts           |

Most templates use `base`, and the rest of this page does. With the default policy, `base` allows
a guest of up to 16384 MiB and 8 vCPUs. The gate-record path is
[the guide's §4b.5](../../../deploy/sbx/template-onboarding/GUIDE.md#4b5-path-b-your-own-gate-record-general-self-benchmark-self).

## 3. Make the image moca-ready

A sandbox's VM boots your image's root filesystem, read-only, with no container runtime. Most
published images need a small layer on top first. Check:

- [ ] **`/etc/hosts` maps `localhost`.** A container runtime writes this file when a container
      starts, so an image often ships an empty one, and nothing in the guest writes it.
- [ ] **The guest agent's tools are there:** `bash`, `ls`, `cat`, `base64` and `file`. Slim images
      often lack `file`.
- [ ] **Every tool your spec's `tools` lists is there.** The build refuses an image missing one.
- [ ] **`ca-certificates` is installed** if the template will use egress (`egress: true`), so HTTPS
      works.
- [ ] **It is built for `linux/amd64`.**

For `python:3.12-slim`, put this `Containerfile` beside a `hosts` file:

```dockerfile
FROM docker.io/library/python:3.12-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends file ca-certificates >/dev/null \
 && rm -rf /var/lib/apt/lists/*
COPY hosts /etc/hosts
```

`hosts` holds exactly these two lines, tab-separated:

```text
127.0.0.1	localhost
::1	localhost ip6-localhost ip6-loopback
```

Build it, push it to an allowed registry (`registry.example.com` stands for yours), and keep the
digest the registry gives it:

```bash
podman build --platform linux/amd64 -t registry.example.com/me/python-moca-min:1 .
podman push --digestfile digest.txt registry.example.com/me/python-moca-min:1
cat digest.txt     # sha256:<64 hex>
```

## 4. Write the spec

Save this as `my-python.json`, with your image and its digest in `image`:

```json
{
  "id": "my-python",
  "image": "registry.example.com/me/python-moca-min@sha256:<64 hex>",
  "guest_ram_mb": 4096,
  "vcpus": 2,
  "egress": false,
  "seed": "",
  "probe": {
    "cmd": "python3 -c 'import sys; print(sys.version_info[:2])'",
    "timeout_s": 60,
    "expect_rc": 0,
    "expect": ["^\\(3, 12\\)$"]
  },
  "description": "Python 3.12",
  "tools": ["bash", "python3"]
}
```

Field by field:

- **`id`**: the name you and others ask for. Lower-case letters, digits and dashes, starting with
  a letter or digit, at most 31 characters. It stays the same across new builds.
- **`image`**: your image, pinned by digest. No tag beside the digest.
- **`guest_ram_mb`**, **`vcpus`**: the VM's memory in MiB (at least 128) and its vCPUs (1 to 32),
  within your profile's limits. They are fixed in the build.
- **`egress`**: `false` gives the sandbox no network at all. `true` gives it the KVM host's
  allowlisted egress.
- **`seed`**: a bash command that fills a new sandbox's empty `/workspace` (a `git clone`, say), or
  `""` for none.
- **`probe`**: the build's own check, run in a microVM restored from the new snapshot, after the
  seed. It passes when `cmd` exits `expect_rc` within `timeout_s` seconds and its output matches
  every extended regex in `expect`. Here it proves Python 3.12 runs in the guest.
- **`description`**: what others read in the template list. It must not be empty.
- **`tools`**: the tools your template carries, as the list shows them. Each must be in the image.

Every field is described in [the guide's §3](../../../deploy/sbx/template-onboarding/GUIDE.md#3-the-template-spec),
and more samples are in [the onboarding examples](../../../deploy/sbx/template-onboarding/examples).

**Leave `skip_git_identity_check` out.** An image with no git passes the git identity check by
itself. Setting the skip needs a gate record, under every profile (rule `X12`).

## 5. Check it, create it, follow the build

A dry run reads the policy and runs the checks that need only your inputs. Nothing is created:

```bash
mocactl sbx templates create --spec my-python.json --profile base --dry-run
```

```text
my-python: passes the local checks (base)
```

Whether your registry is allowed, and your quota, only the server decides. Create it:

```bash
mocactl sbx templates create --spec my-python.json --profile base
```

```text
my-python b-<handle> queued
```

Then follow the build. A host claims it, builds the snapshot and runs your probe:

```bash
mocactl sbx templates follow my-python
```

It says each status it passes (`queued`, `building`, `probing`), and exits 0 once the build is
`registered`, printing the build's id (`sha256:…`) and its `default` tag. It exits 1 on `failed`
or `rejected`, with the reason, and 5 past its timeout (3600 s by default).

## 6. Activate it and try it

A host-built template's worker runs only while someone holds an **activation lease** on it. Take
one, and wait until it is active:

```bash
mocactl sbx templates activate my-python --wait
```

```text
my-python sha256:<64 hex> active, leased until <time>
```

While it waits, it says why (queued at a position, no slot, memory). Then create a sandbox from
it, and run something:

```bash
mocactl sbx create --template my-python --seed
mocactl sbx run --sandbox <sandbox id> -- python3 --version
```

`--seed` runs the build's seed as the sandbox's first command; with `"seed": ""` there is nothing to
run. In a git repository, `mocactl sbx up --template my-python` brings the repository up in a
sandbox of your template instead.

**If `activate --wait` keeps waiting**, the build's worker may not be installed on
its host yet: the host agent builds templates but installs no worker, so an operator does that once
per build. Ask your operator.

When you are done, release the lease (`mocactl sbx templates deactivate my-python`), and delete
the sandbox (`mocactl sbx rm <sandbox id>`).

## 7. Make it available to others

**A new template is visible to everyone on the deployment by default** (`deployment` visibility):
every user sees it in `mocactl sbx templates ls`, and can activate it and create sandboxes from it.
To keep it to yourself, create it with `--visibility private`, or change it later:

```bash
mocactl sbx templates edit my-python --visibility private
mocactl sbx templates edit my-python --visibility deployment
```

Other users name it like you do: `my-python` is the build the `default` tag names. A template's
first registered build takes `default`, and a later build does not move it. When a new build is
ready for everyone, move the tag with `mocactl sbx templates tag my-python default --build <build id>`
([Make your own templates](templates.md) covers updates and retiring).

**The exception: a self-attested template stays private.** A template built on `general-self` or
`benchmark-self` with your own gate record is yours alone. Making it `deployment`-visible is
refused `409 self_attested` until an admin trusts its gate record, and then it may be shared.

## 8. When a create is refused

A create the policy refuses is `422 policy_refused`, and names the first rule it failed. Nothing
is created. The common ones:

| Rule                  | What it means                                 | What to change                                                                               |
| --------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `registry`            | the image's registry is not in the policy     | push to a registry `mocactl sbx policy` lists; never another host name for the same registry |
| `registry.repository` | that registry admits only listed repositories | ask an admin to list yours                                                                   |
| `M1`                  | the image is not pinned by digest             | write `repository@sha256:<64 hex>`, with no tag                                              |
| `M7.id`               | the id is not well formed                     | lower-case letters, digits and dashes, at most 31 characters                                 |
| `envelope`            | the size is outside the profile's limits      | fit `guest_ram_mb` and `vcpus` to the profile (`mocactl sbx policy`)                         |
| `X12`                 | `skip_git_identity_check` with no gate record | drop the field                                                                               |

Other refusals: `429 quota_exceeded` when a quota is full (`mocactl sbx quota`), and
`409 template_exists` when the id is someone else's. A build that fails later, on the host, is
`failed` with a reason: `probe_failed` when the probe printed something else (match its output
exactly, and check the moca-ready list above). Every rule id and error code is in the
[Template API](../reference/templates-api.md#policy-rule-ids).

## Next

- [Make your own templates](templates.md): every flag, new builds, tags, retiring, and pinning a
  Moca Pi session to a build.
- [Templates, builds and activation](../concepts/templates.md): build statuses, readiness and
  leases.
- [Template API](../reference/templates-api.md): the routes, error codes, rule ids and quotas.
