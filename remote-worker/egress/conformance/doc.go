// Package conformance is the black-box conformance suite for the moca-egress
// contract (MI1 docs/specs/2026-09-28-moca-multi-user-isolation-design.md,
// section 12.3). Any implementation of the contract, moca-egress first and
// Cortex later (MI1 S6), runs the same named cases against its external
// interfaces only:
//
//   - the MOCA_EGRESS_* and MOCA_TENANCY environment variables;
//   - the section 8.3 control protocol, driven here by a fake vmpool that hands
//     each VM's listening socket over with control.Client;
//   - the per-VM HTTP/1.1 proxy socket (CONNECT and absolute-form http://);
//   - named refusals (X-Moca-Egress-Error, a "<code>: <host>\n" text/plain body);
//   - one JSON audit event per line on the implementation's stdout.
//
// The package lives outside internal/ on purpose: Go's import rule would
// otherwise stop any other module from ever running it. It does not import
// moca-egress itself. A Target starts an implementation; ProcessTarget execs a
// binary, and cmd/moca-egress-conformance is the runnable form.
//
// Every case brings its own fake DNS server (MOCA_EGRESS_RESOLVER), fake
// upstreams on 127.0.0.1 (permitted with MOCA_EGRESS_PERMIT_CIDRS where a case
// needs to reach them), a fresh control socket and a fresh instance.
//
// Audit contract. The suite reads these fields of the audit events, and an
// implementation must emit them as described:
//
//   - via: the string "moca-egress" on every event;
//   - vm_id, sid: the VM and session the conn's listener was registered with;
//   - sub: the subject, present on credential_injected events (the lookup's
//     subject, for the audit only) and absent or "" on every other; this one
//     is checked on every event a case reads, not only those it waits for;
//   - host: the destination host as requested, normalised (lower case, no
//     trailing dot); for conn_cap, which is decided before any request is
//     read, it is not checked;
//   - method: the request method, CONNECT for a tunnel;
//   - path: the escaped request path of a plain-HTTP request, with no query,
//     fragment or userinfo;
//   - status: the HTTP status the guest was answered with, as a number;
//   - decision: one of tunnel, forward, destination_denied,
//     destination_private, conn_cap, request_cap, no_binding,
//     credential_unavailable, upstream_unreachable, bad_request, aborted,
//     credential_injected, credential_revoked, plaintext_credential,
//     upstream_unverified, misdirected_request, leaf_unavailable;
//     leaf_unavailable is a leaf-certificate mint refused because the
//     interception CA has expired, so the guest's TLS handshake fails; its
//     status field records 502 although no HTTP response is sent;
//     exactly one aborted event per conn ended by Unregister;
//   - dial_addr: the ip:port actually dialled. It is the evidence for
//     resolve-once: the suite requires it to equal the first, checked DNS
//     answer;
//   - bytes_up, bytes_down: the bytes carried guest→upstream and
//     upstream→guest, as numbers. They refine MI1 section 8.5's single bytes
//     field (P4.1 amendment of 2026-10-21, item 8).
//
// An intercepted request that no credential covers emits decision=forward with
// its path and status. A credential_revoked event carries credential and sid.
// credential, the name of the credential injected or revoked (never its
// value), is read on credential_injected and credential_revoked events. Other
// fields, such as time, are not read.
//
// Interception. When MOCA_EGRESS_CREDENTIALS_URL is set, the harness also
// provides a fake control plane speaking POST /v1/egress/credential (SBX0.2b
// spec section 4.2), an interception CA, extra upstream roots
// (MOCA_EGRESS_UPSTREAM_CA) and a TLS upstream, all as files and sockets under
// the case's own directory. The cases that need interception are part of the
// contract (SBX0.2b spec docs/specs/2026-10-26-sbx-egress-credentials-design.md
// section 10.2):
//
//   - the placeholder is always overwritten, and a credential is never sent to
//     a non-matching host or path;
//   - a host with no credential is an opaque tunnel;
//   - a lookup error answers 503 credential_unavailable, with no dial;
//   - an upstream certificate failure answers 502 upstream_unverified, not a
//     tunnel;
//   - an inner Host or an SNI that differs from the CONNECT host is refused
//     (421);
//   - a plain-HTTP request to a host with a credential answers
//     403 plaintext_credential, with nothing injected;
//   - credentials are keyed by session, cached and single-flighted;
//   - a credential revoked mid-connection answers 401 credential_revoked on
//     the next request, with zero upstream requests;
//   - path-scoped selection, and the refusal of path confusion;
//   - several headers per credential, and port scoping;
//   - TRACE and TRACK are refused inside an intercepted connection;
//   - exactly one audit event per injection.
//
// With none of the credential variables set, an implementation behaves as the
// transport slice (P4.1, docs/specs/2026-09-15-p4-1-microvm-egress-transport-design.md)
// did, which the cases that do not set them show.
//
// The cases themselves are unix-only, because the control protocol passes the
// listener with SCM_RIGHTS. On other platforms the package is empty.
package conformance
