# Logging in with an OIDC provider (w3id)

The control plane's default identity provider is GitHub's OAuth device flow. Deployments inside
IBM (or in front of any OIDC provider — Keycloak, Dex, Entra) can instead use the generic OIDC
provider, which this guide walks through with w3id as the example.

## How the flow works

mocactl's login is unchanged from its side: it asks the control plane to start a login, opens the
URL it gets back, and polls. What differs is who completes the login in the middle:

```
mocactl                    control plane                      w3id
  │ POST /v1/auth/device      │                                │
  │──────────────────────────>│ mint state + user code (15 m)  │
  │<── verificationUri + code─│                                │
  │                           │                                │
  │ browser opens the authorize URL ─────────────────────────>│
  │                           │                        user signs in
  │                           │<─── redirect: ?code&state ────│
  │                           │ exchange code (server-side),   │
  │                           │ verify id_token vs JWKS,       │
  │                           │ render "enter your code" page  │
  │                           │<─── ?confirm=<user code> ──────│
  │ POST /v1/auth/device/token│                                │
  │──────────────────────────>│                                │
  │<─── api token + refresh ──│                                │
```

The state token mocactl polls with is the same capability a device code is: single-use,
TTL-bound, and worthless until the control plane has verified a provider-signed `id_token`
against it. mocactl never sees the client secret or the authorization code — the exchange
happens entirely server-side, at the control plane's `GET /v1/auth/oidc/callback`.

**The browser-to-terminal binding.** A verified `id_token` is still not a login: the callback
page asks for a short code (`XXXX-XXXX`) that the control plane minted at login start and showed
only in the terminal that started it, and the login settles only when that code is typed (at
most five tries). Without this, the authorize URL alone would be a capability — an attacker who
starts a login and gets a victim with a live w3id SSO session to open the URL would hand the
attacker a fully verified login as the victim, one click and no code to type. With it, the
victim lands on the confirmation page and is asked for a code they have never seen.

Subjects minted this way are `oidc:<provider sub>` (the provider's stable `sub` claim), so
`SH_ADMIN_SUBJECTS` and — on the sandbox profile — `SH_ALLOWED_SUBJECTS` take entries in that
form.

## Registering the application

Register an OIDC client with the provider (for w3id, an IBM SSO application registration) with:

- **Redirect URI:** the control plane's public callback URL — on OpenShift, the control plane's
  Route: `https://<cp-route>/v1/auth/oidc/callback`. Providers match redirect URIs exactly, so
  this must be the URL the browser actually lands on.
- **Grant type:** authorization code (confidential client — the control plane holds the secret).
- **Scopes:** `openid email profile` (the default; override with `SH_OIDC_SCOPE`).

For w3id preprod, the issuer is `https://preprod.login.w3.ibm.com/oidc/endpoint/default`. The
provider must serve standard discovery (`/.well-known/openid-configuration`) and sign `id_token`s
with RS256.

## Configuring the control plane

```ini
SH_IDENTITY_PROVIDER=oidc
SH_OIDC_ISSUER=https://preprod.login.w3.ibm.com/oidc/endpoint/default
SH_OIDC_CLIENT_ID=<registered client id>
SH_OIDC_REDIRECT_URI=https://<cp-route>/v1/auth/oidc/callback
# The secret is a credential, not an env var in a committed file:
#   systemd: LoadCredential=SH_OIDC_CLIENT_SECRET:/path
#   k8s:     a Secret, mounted or resolved like the other CONTROL_PLANE_SECRETS
SH_OIDC_CLIENT_SECRET=<runtime secret>
SH_ADMIN_SUBJECTS=oidc:<your sub>          # optional: the admin role
```

On Kubernetes/OpenShift (`deploy/k8s`), expose the control plane behind a Route (TLS — the
redirect URI must be https) and pass the secret like the other control-plane secrets. The route
must reach **a single replica or a shared pending-auth store**: the state is parked in the
control plane's memory, so a callback that load-balances to a different pod than the one that
issued the state will not find it. Run one replica, or contribute a Redis-backed
`PendingAuthStore` (see `packages/control-plane/src/oidc.ts`) before scaling out.

The pending store is also **capped, not fair**: 10,000 live states bound the control plane's
memory, and the login-start route is unauthenticated, so one client looping starts can fill the
cap and every real user then gets 429 for up to the state TTL (15 minutes). A per-source bound
on outstanding starts is the follow-up.

## Logging in

`mocactl login` is the same command, and the rhythm is the device flow's: the terminal shows a
code, the browser asks for it. The user signs in at the provider (an existing w3id SSO session,
usually), lands on the moca confirmation page, and enters the terminal's code there:

```
$ mocactl login
Open https://preprod.login.w3.ibm.com/oidc/endpoint/default/authorize?... and enter the code XY7C-K2M9
  (valid for 15 minutes, Ctrl-C to cancel)
logged in as alex@us.ibm.com
```

Sign in at w3id, then enter the terminal's code on the confirmation page the redirect lands
on — the same paste-and-confirm rhythm as GitHub's device flow.

Everything after the login — refresh rotation, API tokens, session ownership, `mocactl auth
token` — is identical to the GitHub flow, because none of it knows which provider produced the
subject.
