# @moca/control-plane

The MU1 multi-user control plane: login (GitHub device flow), sessions and their ownership index,
per-user credentials, and the session tokens the harness verifies. Design:
[`docs/specs/2026-09-08-multi-user-control-plane-design.md`](../../docs/specs/2026-09-08-multi-user-control-plane-design.md).

```bash
node --import tsx src/main.ts        # from this directory; tsx resolves from the package dir
```

Deployments: `deploy/vm/systemd/`, `deploy/k8s/base/control-plane.yaml`
(Kubernetes) and the `control-plane` profile in
[`deploy/compose`](../../deploy/compose/README.md#using-mocactl-the-control-plane).

## Required settings

The control plane refuses to start without any of these:

| Variable                       | What it is                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `SH_SESSION_TOKEN_PRIVATE_KEY` | ed25519 signing key: PKCS#8 PEM, or the same DER as one line of base64 (for env files).        |
| `SH_CREDENTIAL_KEK`            | 32 bytes, base64. A comma-separated ring, newest first, during a rotation (`src/envelope.ts`). |
| `SH_EXCHANGE_TOKEN`            | The shared bearer the harness presents on the exchange hop. Set the same value on the harness. |
| `SH_GITHUB_CLIENT_ID`          | A GitHub OAuth app with device flow enabled.                                                   |

`node --import tsx src/genkeys.ts` prints a fresh set of the first three, plus
`SH_SESSION_TOKEN_PUBLIC_KEYS` for the harness, as env-file lines on stdout.

## Credential stores

`SH_CREDENTIAL_STORE` picks where credentials live. All three sit behind one `CredentialStore`
interface (`src/credential-store.ts`) and keep its invariants:

- **Exact-name lookup only.** Each subject's credentials live in one object, named by a hash of the
  subject. No store needs a list or enumerate permission, and none discloses a login in an object
  name.
- **Envelope encryption under `SH_CREDENTIAL_KEK`, whatever the backend.** A reader of the backend
  sees ciphertext. The AAD is `subject|name`, so a writer cannot relabel one subject's ciphertext as
  another's.
- **`list` decrypts nothing.** Descriptors are stored beside the ciphertext, not inside it.

| Value                  | Store                                                                           | For                                       |
| ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| `kubernetes` (default) | one Secret per subject in `SH_CREDENTIAL_NAMESPACE` (`src/k8s-secret-store.ts`) | Kubernetes / OpenShift                    |
| `file`                 | one 0600 JSON file per subject in `SH_CREDENTIAL_DIR` (`src/file-store.ts`)     | a single-host trial (`deploy/compose`)    |
| `vault`                | HashiCorp Vault KV v2 (`src/vault-store.ts`)                                    | VM deployments: test, staging, production |

An unknown value fails startup; it never falls back to the default.

### `file`

`SH_CREDENTIAL_DIR` is created 0700 if missing, and must be writable at startup. Writes go to a
temp file, are fsynced, then renamed into place. Writes for one subject are serialized within the
process. Two control-plane processes sharing one directory are **not** supported.

### `vault`

| Variable            | Default            | Notes                                                                           |
| ------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `VAULT_ADDR`        | required           | e.g. `https://vault.internal:8200`. A path on it is kept (for a proxied Vault). |
| `VAULT_TOKEN`       | one of these two   | A Vault token.                                                                  |
| `VAULT_TOKEN_FILE`  | one of these two   | Re-read on every request. Point it at a Vault Agent sink.                       |
| `VAULT_NAMESPACE`   | unset              | Vault Enterprise / HCP namespace.                                               |
| `SH_VAULT_KV_MOUNT` | `secret`           | A **KV v2** mount.                                                              |
| `SH_VAULT_PATH`     | `moca/credentials` | Path under the mount. Each subject is `<mount>/data/<path>/<subject hash>`.     |

Prefer `VAULT_TOKEN_FILE` with [Vault Agent](https://developer.hashicorp.com/vault/docs/agent-and-proxy/agent)
doing the login (AppRole, cloud IAM, …) and the token renewal. That way the control plane never
holds a long-lived credential of its own. For TLS to a private CA, set Node's `NODE_EXTRA_CA_CERTS`.

The minimum policy has **no `list`**:

```hcl
path "secret/data/moca/credentials/*" {
  capabilities = ["create", "read", "update"]
}
```

Writes are read-modify-write under KV v2 check-and-set, so concurrent writes for one subject from
several control-plane replicas cannot drop each other's credential. A write that loses the race
re-reads and retries.

`test/vault-store.live.test.ts` runs the store against a real Vault. A dev server is enough:

```bash
docker run -d --rm -p 127.0.0.1:18200:8200 -e VAULT_DEV_ROOT_TOKEN_ID=dev-root hashicorp/vault:1.18
SH_VAULT_LIVE_ADDR=http://127.0.0.1:18200 SH_VAULT_LIVE_TOKEN=dev-root \
  ./node_modules/.bin/vitest run test/vault-store.live.test.ts
```
