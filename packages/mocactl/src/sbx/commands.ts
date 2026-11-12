import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// sandbox-client's POSIX single quotes: safe to `eval`, whatever the control plane sent.
import { q } from '@moca/sandbox-client';
import { ApiError, TOKEN_CODES } from '../api/errors.js';
import { deviceLogin, toCachedAuth } from '../core/auth.js';
import { describeError } from '../core/messages.js';
import { sanitizeRemote } from '../core/sanitize.js';
import { saveConfig, storedLoginUrl } from '../config.js';
import { deviceLoginEnd, devicePrompt, type Io, type LoginHelpers } from '../headless.js';
import { setAuth, type RefreshFailure, type Runtime } from '../runtime.js';
import type { SandboxApiClient, SbxDiscovery, SbxSandbox } from './api.js';
import { sandboxFailureText, type ExecFactory } from './exec.js';
import { seedSandbox, type SeedResult } from './templates.js';

/**
 * `mocactl sbx`'s exit codes (SBX0 §6.1), as `mocactl auth token`'s beyond 0 and 2; 5 when a wait
 * (`templates activate --wait`) ran out of time.
 */
export const SBX_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  loginRequired: 3,
  unreachable: 4,
  timedOut: 5,
} as const;

export interface SbxCtx {
  rt: Runtime;
  api: SandboxApiClient;
  url: string;
  io: Io;
  json: boolean;
  signal?: AbortSignal;
  /**
   * The control-plane URL when it came from `--control-plane-url` or MOCACTL_SBX_URL rather than
   * config.json: `SBX_TOKEN_CMD` then names it, since another shell may have neither.
   */
  explicitUrl?: string;
}

export type { RefreshFailure };

/**
 * The not-enrolled refusal: the control plane's own message, which names the caller's subject
 * (`github:<id>`, what the operator adds), then what to do about it.
 */
export function notEnrolledMessage(err: ApiError): string {
  const server =
    err.message && err.message !== err.code
      ? sanitizeRemote(err.message)
      : 'this GitHub account is not enrolled in the sandbox service';
  return `sbx: ${server}; ask an operator to add it`;
}

/**
 * A refresh that did not end in "log in again": an ApiError is reported as any other (status 0 is
 * exit 4, `not_enrolled` exit 1); anything else (a timeout, another mocactl holding the refresh
 * lock) means the control plane could not be asked, exit 4, as `mocactl auth token`.
 */
export function failRefresh(io: Io, error: unknown): number {
  if (error instanceof ApiError) return fail(io, error);
  io.err(`sbx: cannot refresh the sandbox-service login: ${describeError(error)}`);
  return SBX_EXIT.unreachable;
}

/** The 404s the sandbox and template routes answer themselves: a real answer about the id. */
const OWN_404 = new Set(['sandbox_not_found', 'template_not_found']);

/**
 * One line per failure. A refusal from the control plane is exit 1 with its message; a network
 * failure (status 0) is exit 4; a token the control plane will not take any more is exit 3 --
 * unless the refresh behind the client's retry failed for another reason, which is then the cause
 * reported (`refreshFailure`).
 */
export function fail(io: Io, err: unknown, refreshFailure?: RefreshFailure): number {
  if (refreshFailure && err instanceof ApiError && TOKEN_CODES.has(err.code)) {
    return failRefresh(io, refreshFailure.error);
  }
  if (err instanceof ApiError && err.status === 0) {
    io.err(`sbx: cannot reach the sandbox control plane: ${describeError(err)}`);
    return SBX_EXIT.unreachable;
  }
  if (err instanceof ApiError && err.code === 'not_enrolled') {
    io.err(notEnrolledMessage(err));
  } else if (err instanceof ApiError && TOKEN_CODES.has(err.code)) {
    io.err('sbx: your sandbox-service login has expired: run `mocactl sbx login`');
    return SBX_EXIT.loginRequired;
  } else if (err instanceof ApiError && err.status === 404 && !OWN_404.has(err.code)) {
    // A heuristic: every sandbox route's own 404 is `sandbox_not_found` (a template route's
    // `template_not_found`), so any other 404 (the server's bare `not_found` for an unmounted route,
    // or a proxy's page) means the URL is not a sandbox-profile control plane -- a MOCA (harness
    // profile) one, or one from before SBX0.
    io.err('sbx: that control plane has no sandbox routes: is it the sandbox service?');
  } else {
    io.err(`sbx: ${describeError(err)}`);
  }
  return SBX_EXIT.failed;
}

/**
 * `fail` with what this command's client saw of its refresh (`rt.lastRefreshFailure`): every sbx
 * command reports through this, so a 401 whose retry refresh failed names the real cause.
 */
export const failed = (c: SbxCtx, err: unknown): number => fail(c.io, err, c.rt.lastRefreshFailure);

export async function cmdLogin(
  c: SbxCtx,
  remember: boolean,
  helpers?: LoginHelpers,
): Promise<number> {
  if (!c.rt.cp) return SBX_EXIT.usage;
  try {
    // Refuse a MOCA control plane before a device code is shown: its login would be useless here.
    const d: SbxDiscovery = await c.api.sandboxDiscovery().catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return {};
      throw err;
    });
    if (d.profile !== 'sandbox') {
      c.io.err(
        `sbx: ${c.url} is not the sandbox service (its /v1/discovery has no sandbox profile)`,
      );
      return SBX_EXIT.usage;
    }
    const login = await deviceLogin(
      { cp: c.rt.cp, sleep: c.rt.sleep, now: c.rt.now },
      devicePrompt(c.io, helpers),
      c.signal,
    );
    setAuth(c.rt, toCachedAuth(login, c.url));
    if (remember) saveConfig(c.rt.paths, { ...c.rt.config, sbxControlPlaneUrl: c.url });
    c.io.err(
      `logged in to the sandbox service as ${sanitizeRemote(login.displayName ?? login.subject)}`,
    );
    return SBX_EXIT.ok;
  } catch (err) {
    const end = deviceLoginEnd(c.io, err, { prefix: 'sbx', again: 'mocactl sbx login' });
    if (end !== undefined) return end;
    return failed(c, err);
  }
}

/**
 * `mocactl sbx logout`: revoke the login's refresh token at the control plane (best effort), then
 * delete `sbx-auth.json`. A login there for another sandbox control plane is left in place and
 * named, since it was not revoked. MOCA's `auth.json` is never touched.
 */
export async function cmdLogout(c: SbxCtx): Promise<number> {
  const auth = c.rt.auth;
  const other = auth ? undefined : storedLoginUrl(c.rt.paths.authFile);
  if (other && other !== c.url) {
    // sbx-auth.json holds ONE login: one for another sandbox control plane is not this logout's to
    // end. It is left, and named, with the command that would end it.
    c.io.err(
      `sbx: not logged in to ${sanitizeRemote(c.url)}; the sandbox-service login on this machine is ` +
        `for ${sanitizeRemote(other)}, left in place (end it with ` +
        `\`mocactl sbx logout --control-plane-url ${q(sanitizeRemote(other))}\`)`,
    );
    return SBX_EXIT.ok;
  }
  let code: number = SBX_EXIT.ok;
  if (auth?.refreshToken && c.rt.cp) {
    try {
      await c.rt.cp.revokeAuth(auth.refreshToken);
    } catch (err) {
      c.io.err(
        `sbx: logged out of this machine, but the control plane did not confirm: ${describeError(err)} ` +
          '(the login stays valid there until it expires)',
      );
      code = SBX_EXIT.failed;
    }
  }
  // Reached only for this control plane's login (or none, or an unreadable file): delete it.
  setAuth(c.rt, null);
  if (code === SBX_EXIT.ok) {
    c.io.err(auth ? 'logged out of the sandbox service' : 'not logged in to the sandbox service');
  }
  return code;
}

const when = (epochS: number) => new Date(epochS * 1000).toISOString();

export async function cmdTemplates(c: SbxCtx): Promise<number> {
  try {
    const ts = await c.api.listTemplates();
    if (c.json) c.io.out(JSON.stringify(ts) + '\n');
    else {
      for (const t of ts) {
        // Readiness and tags (template lifecycle spec §4) when the control plane sends them; an
        // older one sends neither, and the line is as before.
        const ready =
          typeof t.readiness === 'string' ? `${sanitizeRemote(t.readiness).padEnd(9)} ` : '';
        const tags = t.tags ? Object.keys(t.tags).sort().map(sanitizeRemote) : [];
        c.io.out(
          `${sanitizeRemote(t.id).padEnd(16)} ${ready}${sanitizeRemote(t.description)}` +
            `${tags.length ? `  tags ${tags.join(',')}` : ''}\n`,
        );
      }
    }
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** How long `sbx create` and `sbx up` wait for a template to become active (§6.4) before giving up. */
export const ACTIVATION_WAIT_MS = 10 * 60_000;

/**
 * Creates a sandbox, waiting while its template activates (template lifecycle spec §6.4): a
 * `409 template_not_active` means the control plane has started the activation (or, with no lease
 * to take, is waiting for a host), so the create is retried after its Retry-After, saying why, until
 * ACTIVATION_WAIT_MS. Any other refusal is thrown.
 */
export async function createWaitingForActivation(
  c: SbxCtx,
  body: { template: string; name?: string; labels?: Record<string, string> },
): Promise<SbxSandbox & { buildId?: string | null; templateManifestHash?: string | null }> {
  const start = c.rt.now();
  for (;;) {
    try {
      return await c.api.createSandbox(body);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409 && err.code === 'template_not_active'))
        throw err;
      const left = ACTIVATION_WAIT_MS - (c.rt.now() - start);
      if (left <= 0) throw err;
      const waitMs = Math.min(Math.max(1, err.retryAfterS ?? 30) * 1000, left);
      c.io.err(`sbx: ${sanitizeRemote(err.message)}; retrying in ${Math.ceil(waitMs / 1000)} s`);
      await c.rt.sleep(waitMs, c.signal);
      if (c.signal?.aborted) throw err;
    }
  }
}

/**
 * `sbx create [--template ID[:TAG|@BUILD]] [--seed]`. With --seed, the served build's seed runs as
 * the new sandbox's first command and the workspace is checked (seedSandbox): a failure there is
 * exit 1, the sandbox kept and named, so its state can be looked at.
 */
export async function cmdCreate(
  c: SbxCtx,
  body: { template: string; name?: string; labels?: Record<string, string> },
  seed?: { factory?: ExecFactory },
): Promise<number> {
  try {
    const s = await createWaitingForActivation(c, body);
    c.io.err(
      `created ${sanitizeRemote(s.id)} (${sanitizeRemote(s.template)}), expires ${when(s.expiresAt)}`,
    );
    let seeded: SeedResult | undefined;
    if (seed) {
      const r = await seedSandbox(c, s, seed.factory).catch((err: unknown) =>
        err instanceof ApiError ? Promise.reject(err) : sandboxFailureText(err),
      );
      if (typeof r === 'string') {
        if (c.json) c.io.out(JSON.stringify({ ...s, seed: { error: r } }) + '\n');
        else c.io.out(`${sanitizeRemote(s.id)}\n`);
        c.io.err(`sbx: ${sanitizeRemote(s.id)}: ${r}`);
        return SBX_EXIT.failed;
      }
      seeded = r;
      c.io.err(
        r.seed === ''
          ? `${sanitizeRemote(s.id)}: the template has no seed`
          : `seeded ${sanitizeRemote(s.id)}${r.head ? `: a clean tree at ${r.head}` : ''}`,
      );
    }
    if (c.json) c.io.out(JSON.stringify(seeded ? { ...s, seed: seeded } : s) + '\n');
    else c.io.out(`${sanitizeRemote(s.id)}\n`);
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

function stateText(s: SbxSandbox): string {
  if (s.state !== 'terminated') return s.state;
  return s.reason ? `terminated (${s.reason})` : 'terminated';
}

export async function cmdLs(c: SbxCtx, all: boolean): Promise<number> {
  try {
    const ss = await c.api.listSandboxes({ all });
    if (c.json) {
      c.io.out(JSON.stringify(ss) + '\n');
      return SBX_EXIT.ok;
    }
    for (const s of ss) {
      // Sanitized before padding, so stripped control characters cannot skew the columns.
      const cell = (v: string, width = 0) => sanitizeRemote(v).padEnd(width);
      const row = [
        cell(s.id, 30),
        cell(s.name ?? '-', 16),
        cell(s.template, 12),
        cell(stateText(s), 22),
        when(s.expiresAt),
        ...(all ? [cell(s.owner)] : []),
      ].join(' ');
      c.io.out(row + '\n');
    }
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/**
 * `sbx rm`. `goneOk`: the id is the repository's bound sandbox, so one the control plane no longer
 * knows (purged after its retention) is "already gone" (exit 0), and `rm` can still take back
 * the configuration `up` wrote. Any other id's 404 is the failure it was.
 */
export async function cmdRm(c: SbxCtx, id: string, o: { goneOk?: boolean } = {}): Promise<number> {
  try {
    const r = await c.api.deleteSandbox(id);
    if (c.json) c.io.out(JSON.stringify(r) + '\n');
    // Delete is not immediate (SBX0 §5.4): a token already minted works until it expires, plus the
    // relay's 30 s leeway. The client does not know the deployment's token lifetime, so the default.
    c.io.err(
      r.reason === 'expired'
        ? `${id} had already expired`
        : `deleted ${id}; tokens already issued stop working within one token lifetime plus 30 s ` +
            '(15.5 minutes by default)',
    );
    return SBX_EXIT.ok;
  } catch (err) {
    if (o.goneOk && err instanceof ApiError && err.code === 'sandbox_not_found') {
      if (c.json) c.io.out(JSON.stringify({ id, state: 'terminated', reason: 'gone' }) + '\n');
      c.io.err(`${id} is already gone (the control plane no longer has it)`);
      return SBX_EXIT.ok;
    }
    return failed(c, err);
  }
}

/**
 * `sbx egress`: a sandbox's egress, as its KVM host's proxy logged it. Text: the
 * summary per host, then whether the log is complete and its digest. `--json`: every event and the
 * summary, read page by page. `--ndjson`: the log exactly as served, whose sha256 the summary and the
 * sandbox's end record name (verify-provenance.py --egress checks a saved copy).
 */
export async function cmdEgress(
  c: SbxCtx,
  id: string,
  ndjson: boolean,
  verify = false,
): Promise<number> {
  try {
    if (verify) return await verifyEgress(c, id);
    if (ndjson) {
      const body = await c.api.sandboxEgressNdjson(id);
      if (c.io.outBytes) c.io.outBytes(Buffer.from(body, 'utf8'));
      else c.io.out(body);
      return SBX_EXIT.ok;
    }
    let page = await c.api.sandboxEgress(id, { limit: 1000 });
    const summary = page.summary;
    if (c.json) {
      const events = [...page.events];
      while (page.next !== null) {
        page = await c.api.sandboxEgress(id, { after: page.next, limit: 1000 });
        events.push(...page.events);
      }
      c.io.out(JSON.stringify({ events, summary }) + '\n');
      return SBX_EXIT.ok;
    }
    const hosts = Object.entries(summary.byHost).sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [host, h] of hosts) {
      const decisions = Object.entries(h.decisions)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([d, n]) => `${sanitizeRemote(d)} ${n}`)
        .join(', ');
      c.io.out(
        `${sanitizeRemote(host || '-').padEnd(40)} ${String(h.count).padStart(6)}  ` +
          `up ${h.bytesUp} B, down ${h.bytesDown} B  (${decisions})\n`,
      );
    }
    c.io.out(
      `${summary.total} events; ` +
        (summary.complete ? 'complete' : `INCOMPLETE: ${summary.dropped} dropped`) +
        `; ${sanitizeRemote(summary.sha256)}\n`,
    );
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/**
 * `sbx egress ID --verify`: the log as served, its sha256 and line
 * count checked against the summary's, which is what the sandbox's end record names (as
 * verify-provenance.py --egress checks a saved copy against the record). Exit 0 only when both match.
 */
async function verifyEgress(c: SbxCtx, id: string): Promise<number> {
  const summary = (await c.api.sandboxEgress(id, { limit: 1 })).summary;
  const body = await c.api.sandboxEgressNdjson(id);
  const sha256 = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
  const lines = body.split('\n').filter((l) => l !== '').length;
  const ok = sha256 === summary.sha256 && lines === summary.total;
  if (c.json)
    c.io.out(
      JSON.stringify({
        verified: ok,
        sha256,
        lines,
        summary: { sha256: summary.sha256, total: summary.total, complete: summary.complete },
      }) + '\n',
    );
  else
    c.io.out(
      ok
        ? `verified: ${lines} events, ${sanitizeRemote(sha256)}${summary.complete ? '' : `; INCOMPLETE: ${summary.dropped} dropped`}\n`
        : `NOT verified: the log served is ${lines} events, ${sanitizeRemote(sha256)}; the summary names ${summary.total}, ${sanitizeRemote(summary.sha256)}\n`,
    );
  return ok ? SBX_EXIT.ok : SBX_EXIT.failed;
}

export async function cmdToken(c: SbxCtx, id: string): Promise<number> {
  try {
    const t = await c.api.mintSandboxToken(id);
    c.io.out(
      (c.json ? JSON.stringify({ token: t.token, expiresAt: t.expiresAt }) : t.token) + '\n',
    );
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/**
 * Write-then-rename into a 0700 directory, chmodding both, so the file is 0600 even when a
 * previous run (or a leftover temp file) left it otherwise.
 */
function writeCa(dir: string, name: string, pem: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, pem, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

/**
 * The command a client runs for a token. A URL from a flag or MOCACTL_SBX_URL is named in it,
 * quoted, so the command works in a shell that has neither; one from config.json is left out.
 */
export function tokenCmd(explicitUrl: string | undefined, id: string): string {
  return explicitUrl
    ? `mocactl sbx token --control-plane-url ${q(explicitUrl)} ${id}`
    : `mocactl sbx token ${id}`;
}

/**
 * Exports for a direct sandbox/v1 client (SBX0 §6.1, §7): where to dial, what to put in the
 * request, and the command that mints a token -- never the token itself, which lives 15 minutes by default.
 */
export async function cmdEnv(c: SbxCtx, id: string): Promise<number> {
  try {
    const t = await c.api.mintSandboxToken(id);
    const lines: Array<[string, string]> = [
      ['SBX_ADDR', sanitizeRemote(t.execEndpoint)],
      ['SBX_TLS', '1'],
      ['SBX_SANDBOX_ID', sanitizeRemote(t.wrk)],
      ['SBX_WORKSPACE_KEY', sanitizeRemote(t.wsk)],
      ['SBX_TOKEN_CMD', tokenCmd(c.explicitUrl, id)],
    ];
    if (t.execCa) {
      // Absolute even when XDG_STATE_HOME is relative: the line is meant for another process.
      const dir = resolve(c.rt.paths.stateDir, 'sbx');
      lines.push(['SBX_CA_FILE', writeCa(dir, `${id}-exec-ca.crt`, t.execCa)]);
    }
    for (const [k, v] of lines) c.io.out(`export ${k}=${q(v)}\n`);
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}
