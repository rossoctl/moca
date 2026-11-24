import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// sandbox-client's POSIX single quotes: safe to `eval`, whatever the control plane sent.
import { q } from '@moca/sandbox-client';
import { ApiError, TOKEN_CODES } from '../api/errors.js';
import { deviceLogin, toCachedAuth } from '../core/auth.js';
import { describeError, describeLoginError, displayUrl } from '../core/messages.js';
import { sanitizeRemote } from '../core/sanitize.js';
import { sameControlPlane, saveConfig, storedLoginUrl } from '../config.js';
import { deviceLoginEnd, devicePrompt, type Io, type LoginHelpers } from '../headless.js';
import { setAuth, type RefreshFailure, type Runtime } from '../runtime.js';
import type {
  SandboxApiClient,
  SbxDiscovery,
  SbxQuota,
  SbxSandbox,
  SbxSandboxCreate,
  SbxSubject,
} from './api.js';
import { openExec, sandboxFailureText, type ExecFactory } from './exec.js';
import {
  modeRank,
  pendingText,
  sendSetMode,
  setModeFailureText,
  type SetModeOutcome,
} from './mode.js';
import { sandboxName } from './names.js';
import { afterText, lifetimeNotTakenText, relativeText } from './lifetime.js';
import { forgetNotices } from './notices.js';
import { SANDBOX_ID_RE } from './state.js';
import { seedSandbox, type SeedResult } from './templates.js';

/**
 * `mocactl sbx`'s exit codes (SBX0 §6.1), as `mocactl auth token`'s beyond 0 and 2; 5 when a wait
 * (`templates follow`, a create waiting for a queue slot, `templates activate --wait`) ran out of
 * time; 130 when Ctrl-C stopped it, as `sbx run` and `sbx rm`.
 */
export const SBX_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  loginRequired: 3,
  unreachable: 4,
  timedOut: 5,
  interrupted: 130,
} as const;

export interface SbxCtx {
  rt: Runtime;
  api: SandboxApiClient;
  url: string;
  io: Io;
  json: boolean;
  signal?: AbortSignal;
  /**
   * The template commands' sleep and clock, and `token --renew-every`'s sleep (default the
   * runtime's); tests pass fakes.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** The default sandbox name's pick, 0 to 1 (default Math.random); tests pass a fake. */
  random?: () => number;
  /**
   * The control-plane URL when it came from `--control-plane-url` or MOCACTL_SBX_URL rather than
   * config.json: `SBX_TOKEN_CMD` then names it, since another shell may have neither.
   */
  explicitUrl?: string;
  /**
   * Where this command records each Exec attempt (the flight recorder, format 2): set by the CLI
   * for every command; `sbx mcp` records per call instead, so it opens its Execs without it.
   */
  execRecord?: ExecRecordTarget;
}

/** A command's Exec records: the flight recorder's directory, and what every line names. */
export interface ExecRecordTarget {
  stateDir: string;
  /** `sbx run`, `sbx push`, …. */
  command: string;
  /** This process's id, the same as `--record`'s `invocation` when that is on. */
  invocation: string;
  /** MOCACTL_SBX_RUN_ID, when set: optional, never required. */
  run?: string;
}

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

/** What to run next when the control plane could not be asked: `sbx doctor` checks it step by step. */
const DOCTOR_HINT = 'run `mocactl sbx doctor` to diagnose';

/** ` at URL` (userinfo, query and fragment dropped), or nothing when the caller has no URL. */
const at = (url?: string): string => (url ? ` at ${sanitizeRemote(displayUrl(url))}` : '');

/**
 * A refresh that did not end in "log in again": an ApiError is reported as any other (status 0 is
 * exit 4, `not_enrolled` exit 1); anything else (a timeout, another mocactl holding the refresh
 * lock) means the control plane could not be asked, exit 4, as `mocactl auth token`.
 */
export function failRefresh(io: Io, error: unknown, url?: string): number {
  if (error instanceof ApiError) return fail(io, error, { url });
  io.err(
    `sbx: cannot refresh the sandbox-service login${at(url)}: ${describeError(error)}; ${DOCTOR_HINT}`,
  );
  return SBX_EXIT.unreachable;
}

/** The 404s the sandbox and template routes answer themselves: a real answer about the id. */
const OWN_404 = new Set(['sandbox_not_found', 'template_not_found']);

/**
 * One line per failure. A refusal from the control plane is exit 1 with its message; a network
 * failure (status 0) is exit 4, naming the control plane tried (`url`) and `sbx doctor`; a token
 * the control plane will not take any more is exit 3 -- unless the refresh behind the client's
 * retry failed for another reason, which is then the cause reported (`refreshFailure`).
 */
function fail(
  io: Io,
  err: unknown,
  opts: { refreshFailure?: RefreshFailure; url?: string | undefined } = {},
): number {
  const { refreshFailure, url } = opts;
  if (refreshFailure && err instanceof ApiError && TOKEN_CODES.has(err.code)) {
    return failRefresh(io, refreshFailure.error, url);
  }
  if (err instanceof ApiError && err.status === 0) {
    // A dropped connection reached the peer, so it is not "cannot reach" (describeError words it).
    const what =
      err.code === 'connection_dropped'
        ? `the sandbox control plane${at(url)}: ${describeError(err)}`
        : `cannot reach the sandbox control plane${at(url)}: ${sanitizeRemote(err.message)}`;
    io.err(`sbx: ${what}; ${DOCTOR_HINT}`);
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
  } else if (err instanceof ApiError && err.code === 'template_retired') {
    // 410 (template lifecycle spec §5.1): not a typo in the id, so say what retired means.
    io.err(
      `sbx: ${describeError(err)}: a retired template or build is never served again; ` +
        'use another build (mocactl sbx templates show ID) or another template',
    );
  } else if (err instanceof ApiError) {
    io.err(`sbx: ${refusalText(err)}`);
  } else {
    io.err(`sbx: ${describeError(err)}`);
  }
  return SBX_EXIT.failed;
}

/**
 * A refusal in one line, with what the body says beside its code: the policy rule a create failed
 * (`422 policy_refused`), or the quota it is over (`429 quota_exceeded`). Server text is sanitized
 * (describeError).
 */
export function refusalText(err: ApiError): string {
  const text = describeError(err);
  if (err.rule !== undefined) return `refused by policy rule ${sanitizeRemote(err.rule)}: ${text}`;
  if (err.quota !== undefined) return `over your ${sanitizeRemote(err.quota)} quota: ${text}`;
  return text;
}

/**
 * `fail` with what this command's client saw of its refresh (`rt.lastRefreshFailure`): every sbx
 * command reports through this, so a 401 whose retry refresh failed names the real cause.
 */
export const failed = (c: SbxCtx, err: unknown): number =>
  fail(c.io, err, { refreshFailure: c.rt.lastRefreshFailure, url: c.url });

/**
 * `sbx login --control-plane-url URL`'s URL, saved to config.json for the commands after it, and,
 * when it replaces another, the change said out loud. Saved even when discovery fails for any
 * reason, or the login after it fails (not enrolled, abandoned): the user named this control plane, so `sbx doctor` and the
 * next `sbx login` should look at it, not the old one. Its old login in sbx-auth.json stays but
 * does not match the new URL, so no command uses it against the new control plane.
 */
function rememberUrl(c: SbxCtx): void {
  const old = c.rt.config.sbxControlPlaneUrl || storedLoginUrl(c.rt.paths.authFile);
  // "The same" as loadAuth means it (sameControlPlane), not only up to a trailing slash.
  const same = old !== undefined && sameControlPlane(old, c.url);
  if (same && c.rt.config.sbxControlPlaneUrl) return;
  if (old && !same) {
    c.io.err(
      `sbx: mocactl's sandbox control plane URL is changing from ` +
        `${sanitizeRemote(displayUrl(old))} to ${sanitizeRemote(displayUrl(c.url))}`,
    );
  }
  c.rt.config = { ...c.rt.config, sbxControlPlaneUrl: c.url };
  saveConfig(c.rt.paths, c.rt.config);
}

export async function cmdLogin(
  c: SbxCtx,
  remember: boolean,
  helpers?: LoginHelpers,
): Promise<number> {
  if (!c.rt.cp) return SBX_EXIT.usage;
  let remembered = false;
  const rememberOnce = (): void => {
    if (!remember || remembered) return;
    remembered = true;
    rememberUrl(c);
  };
  try {
    // Refuse a MOCA control plane before a device code is shown: its login would be useless here.
    const d: SbxDiscovery = await c.api.sandboxDiscovery().catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return {};
      throw err;
    });
    // `combined` serves sessions and sandboxes in one control plane (combined control plane spec).
    if (d.profile !== 'sandbox' && d.profile !== 'combined') {
      c.io.err(
        `sbx: ${c.url} is not the sandbox service (its /v1/discovery has no sandbox profile)`,
      );
      return SBX_EXIT.usage;
    }
    // A sandbox service, or so it says: the URL is the one to use from now on, logged in or not.
    rememberOnce();
    const login = await deviceLogin(
      { cp: c.rt.cp, sleep: c.rt.sleep, now: c.rt.now },
      devicePrompt(c.io, helpers),
      c.signal,
    );
    setAuth(c.rt, toCachedAuth(login, c.url));
    c.io.err(
      `logged in to the sandbox service as ${sanitizeRemote(login.displayName ?? login.subject)}`,
    );
    return SBX_EXIT.ok;
  } catch (err) {
    // Discovery failed for any reason (unreachable, a 5xx, a page that is not JSON), or the login
    // after it did: still the control plane the user asked for, so the next `sbx doctor` checks
    // it. Only one whose discovery answered "not a sandbox service" is not kept.
    rememberOnce();
    const end = deviceLoginEnd(c.io, err, { prefix: 'sbx', again: 'mocactl sbx login' });
    if (end !== undefined) return end;
    return loginFailed(c, err);
  }
}

/**
 * The exit for a login that failed for a reason not specific to the device flow, shared by both
 * login paths. A refusal `fail` words for itself (not enrolled, a token code) keeps its words; any
 * other failure, an API error or not (a proxy's 200 page that is not JSON), names the control plane
 * tried and what came back (#700), at `fail`'s exit codes.
 */
function loginFailed(c: SbxCtx, err: unknown): number {
  const ownWords =
    err instanceof ApiError && (err.code === 'not_enrolled' || TOKEN_CODES.has(err.code));
  if (!ownWords) {
    c.io.err(`sbx: login failed: ${describeLoginError(err, c.url)}`);
    return err instanceof ApiError && err.status === 0 ? SBX_EXIT.unreachable : SBX_EXIT.failed;
  }
  return failed(c, err);
}

/**
 * `mocactl sbx login --test-user N` (ADR-0045): the sandbox service's half of
 * `mocactl login --test-user`, so a multi-user `sbx` test needs no human at a browser. The secret
 * comes from MOCA_TEST_USER_SECRET in the environment, never a flag, for the reason `headless.ts`
 * gives: a flag would put it in the shell history and in every `ps` listing of the machine running
 * the test.
 *
 * A SANDBOX SERVICE of either profile, which is a property of the server, not a policy chosen
 * here: `POST /v1/auth/test-token` is declared for `sandbox` and `combined` alike (control-plane
 * `routes.ts`, ADR-0045), so an sbx-only stack serves browser-free logins too. What is refused
 * here is only a control plane whose `/v1/discovery` has no sandbox profile at all, where the
 * login would be useless. A control plane that simply has the feature off is not refused here --
 * it cannot be, since `/v1/discovery` does not advertise test users; its 404 is the answer, and
 * the catch below turns that into "this control plane has no test users".
 *
 * A login is not yet a usable sandbox: on `combined` the sandbox routes check enrollment, so the
 * operator must also have the subject in SH_ALLOWED_SUBJECTS (or SH_ADMIN_SUBJECTS); that refusal
 * arrives later, from `sbx up`, as `not_enrolled` naming the subject. On `sandbox` enrollment is
 * the login gate itself, so the same configuration is what makes THIS call succeed.
 */
export async function cmdLoginTestUser(
  c: SbxCtx,
  index: number,
  env: NodeJS.ProcessEnv,
  remember: boolean,
): Promise<number> {
  if (!c.rt.cp) return SBX_EXIT.usage;
  // Checked before discovery: no reason to ask a control plane anything when the secret that the
  // request needs is not here.
  const secret = env.MOCA_TEST_USER_SECRET ?? '';
  if (secret === '') {
    c.io.err(
      'sbx: --test-user needs the shared secret in MOCA_TEST_USER_SECRET ' +
        "(the control plane's SH_TEST_USER_SECRET)",
    );
    return SBX_EXIT.usage;
  }
  let remembered = false;
  const rememberOnce = (): void => {
    if (!remember || remembered) return;
    remembered = true;
    rememberUrl(c);
  };
  try {
    const d: SbxDiscovery = await c.api.sandboxDiscovery().catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return {};
      throw err;
    });
    if (d.profile !== 'sandbox' && d.profile !== 'combined') {
      c.io.err(
        `sbx: ${c.url} is not the sandbox service (its /v1/discovery has no sandbox profile)`,
      );
      return SBX_EXIT.usage;
    }
    rememberOnce();
    const login = await c.api.testUserToken(index, secret);
    setAuth(c.rt, toCachedAuth(login, c.url));
    c.io.err(
      `logged in to the sandbox service as ${sanitizeRemote(login.displayName ?? login.subject)}`,
    );
    return SBX_EXIT.ok;
  } catch (err) {
    rememberOnce();
    // The two misconfigurations worth naming, as `cmdLoginTestUser` in headless.ts names them: say
    // the fix, and name only settings. 404 is also the ONLY way to learn the feature is off --
    // /v1/discovery does not advertise test users, so the profile gate above cannot tell.
    if (err instanceof ApiError && err.status === 404) {
      c.io.err(
        'sbx: login failed: this control plane has no test users ' +
          '(set SH_TEST_USERS on it to enable them)',
      );
      return SBX_EXIT.failed;
    }
    if (err instanceof ApiError && err.code === 'unauthorized') {
      c.io.err(
        'sbx: login failed: the test-user secret was refused ' +
          "(MOCA_TEST_USER_SECRET must match the control plane's SH_TEST_USER_SECRET)",
      );
      return SBX_EXIT.failed;
    }
    return loginFailed(c, err);
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

/**
 * A table: the header, then the rows (cells already sanitized), each column as wide as its widest
 * cell so a long value cannot shift the columns after it, two spaces apart; the last column is not
 * padded, so no line ends in spaces.
 */
export function columns(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells.map((v, i) => (i < cells.length - 1 ? v.padEnd(widths[i]!) : v)).join('  ') + '\n';
  return [header, ...rows].map(line).join('');
}

export async function cmdTemplates(c: SbxCtx): Promise<number> {
  try {
    const ts = await c.api.listTemplates();
    if (c.json) {
      c.io.out(JSON.stringify(ts) + '\n');
      return SBX_EXIT.ok;
    }
    // No header for an empty list, so "nothing" stays empty output.
    if (ts.length === 0) return SBX_EXIT.ok;
    // READINESS and TAGS (template lifecycle spec §4) when the control plane sends them; an older
    // one sends neither, and the table is ID and DESCRIPTION. DESCRIPTION, free text, comes last.
    const withReadiness = ts.some((t) => typeof t.readiness === 'string');
    const withTags = ts.some((t) => t.tags !== undefined);
    const header = [
      'ID',
      ...(withReadiness ? ['READINESS'] : []),
      ...(withTags ? ['TAGS'] : []),
      'DESCRIPTION',
    ];
    const rows = ts.map((t) =>
      [
        t.id,
        ...(withReadiness ? [typeof t.readiness === 'string' ? t.readiness : '-'] : []),
        ...(withTags
          ? [
              Object.keys(t.tags ?? {})
                .sort()
                .join(',') || '-',
            ]
          : []),
        t.description,
      ].map(sanitizeRemote),
    );
    c.io.out(columns(header, rows));
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** `sbx templates tag ID TAG... --build B` (lifecycle spec §5.1): move tags onto a build. */
export async function cmdTagTemplate(
  c: SbxCtx,
  id: string,
  tags: string[],
  build: string,
): Promise<number> {
  try {
    const r = await c.api.moveTemplateTags(id, tags, build);
    if (c.json) c.io.out(JSON.stringify(r) + '\n');
    else
      for (const t of r.tags) {
        const was = !t.record
          ? ' (unchanged)'
          : t.before
            ? ` (was ${sanitizeRemote(t.before)})`
            : ' (new)';
        c.io.out(
          `${sanitizeRemote(r.templateId)}:${sanitizeRemote(t.tag)} -> ${sanitizeRemote(t.buildId)}${was}\n`,
        );
      }
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** `sbx templates untag ID TAG` (lifecycle spec §5.1): remove a tag; its build stays. */
export async function cmdUntagTemplate(c: SbxCtx, id: string, tag: string): Promise<number> {
  try {
    const r = await c.api.removeTemplateTag(id, tag);
    if (c.json) c.io.out(JSON.stringify(r) + '\n');
    else
      c.io.out(
        `removed ${sanitizeRemote(r.templateId)}:${sanitizeRemote(r.tag)} (was ${sanitizeRemote(r.before)})\n`,
      );
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** `sbx templates edit ID [--visibility V] [--description D]` (lifecycle spec §5.1). */
export async function cmdEditTemplate(
  c: SbxCtx,
  id: string,
  body: { visibility?: string; description?: string },
): Promise<number> {
  try {
    const r = await c.api.updateTemplate(id, body);
    if (c.json) c.io.out(JSON.stringify(r) + '\n');
    else if (r.changes.length === 0) c.io.out(`${sanitizeRemote(r.templateId)}: unchanged\n`);
    else
      for (const ch of r.changes)
        c.io.out(`${sanitizeRemote(r.templateId)}: ${sanitizeRemote(ch.field)} changed\n`);
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** `sbx templates transfer ID SUBJECT` (lifecycle spec §5.2; admins only). */
export async function cmdTransferTemplate(c: SbxCtx, id: string, owner: string): Promise<number> {
  try {
    const r = await c.api.transferTemplateOwner(id, owner);
    if (c.json) c.io.out(JSON.stringify(r) + '\n');
    else
      c.io.out(
        `${sanitizeRemote(r.templateId)}: owner ${sanitizeRemote(r.owner)}${r.record ? ` (was ${sanitizeRemote(r.before ?? 'none')})` : ' (unchanged)'}\n`,
      );
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** How long `sbx create` and `sbx up` wait for a template to become active (§6.4) before giving up. */
const ACTIVATION_WAIT_MS = 10 * 60_000;

/** ` named eager-hopper`, or nothing for a record with no name (a control plane that dropped it). */
export const namedText = (s: { name?: string | null }): string =>
  s.name ? ` named ${sanitizeRemote(s.name)}` : '';

/** Tries at a default name before a `name_conflict` is the user's to see. */
const NAME_TRIES = 5;

/**
 * Creates a sandbox, waiting while its template activates (template lifecycle spec §6.4): a
 * `409 template_not_active` means the control plane has started the activation (or, with no lease
 * to take, is waiting for a host), so the create is retried after its Retry-After, saying why, until
 * ACTIVATION_WAIT_MS. With no name given, one is made up (`adjective-surname`), and a
 * `409 name_conflict` on it is retried with another, up to NAME_TRIES: the user did not pick it, so
 * a clash is not theirs to fix. A name the user gave stays theirs: its clash is thrown. Any other
 * refusal is thrown.
 */
export async function createWaitingForActivation(
  c: SbxCtx,
  given: { template: string; name?: string; labels?: Record<string, string> },
): Promise<SbxSandbox & { buildId?: string | null; templateManifestHash?: string | null }> {
  const start = c.rt.now();
  const madeUp = given.name === undefined;
  const named = () => (madeUp ? { ...given, name: sandboxName(c.random) } : given);
  let body = named();
  let nameTries = 1;
  for (;;) {
    try {
      return await c.api.createSandbox(body);
    } catch (err) {
      if (
        madeUp &&
        err instanceof ApiError &&
        err.code === 'name_conflict' &&
        nameTries < NAME_TRIES
      ) {
        nameTries += 1;
        body = named();
        continue;
      }
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
 * `sbx create [--template ID[:TAG|@BUILD]] [--mode M] [--seed]`. A lease mode is stored by the
 * create at epoch 1, which the worker serves per-Exec until a set_mode makes the epoch known (spec
 * §8.2): the create answers no set-mode token, so one is minted and sent first, before the seed. A
 * pending set_mode is a warning (exit 0); a refused one is exit 1, the sandbox kept and named. With
 * --seed, the served build's seed runs as the new sandbox's first command and the workspace is
 * checked (seedSandbox): a failure there is exit 1, the sandbox kept and named, so its state can be
 * looked at.
 */
export async function cmdCreate(
  c: SbxCtx,
  body: SbxSandboxCreate,
  o: { seed?: boolean; factory?: ExecFactory } = {},
): Promise<number> {
  try {
    const s = await createWaitingForActivation(c, body);
    const id = sanitizeRemote(s.id);
    c.io.err(
      `created ${id}${namedText(s)} (${sanitizeRemote(s.template)}), expires ${when(s.expiresAt)}${afterText(s)}`,
    );
    // A control plane from before modes ignores the body's mode: say so, never a silent per-exec.
    if (body.mode !== undefined && s.mode !== body.mode) {
      c.io.err(
        `sbx: ${id} is ${s.mode}, not ${body.mode}: the control plane did not take the mode`,
      );
    }
    const notTaken = lifetimeNotTakenText(id, body.idleLifetimeS, s);
    if (notTaken) c.io.err(notTaken);
    let setMode: { outcome: 'applied' } | { outcome: 'pending'; code: string } | undefined;
    if (modeRank(s.mode) > 0) {
      const r = await sendCreatedMode(c, s.id, o.factory).catch((err: unknown) => ({
        outcome: 'failed' as const,
        err,
      }));
      if (r.outcome === 'failed' && c.signal?.aborted) {
        // Ctrl-C: the mode is stored, as for a pending set_mode; the seed is not run (P4-R12).
        const pending = { outcome: 'pending', code: 'cancelled' };
        c.io.out(c.json ? JSON.stringify({ ...s, setMode: pending }) + '\n' : `${id}\n`);
        c.io.err(`sbx: ${pendingText(id, 'cancelled')}`);
        return SBX_EXIT.interrupted;
      }
      if (r.outcome === 'failed') {
        // The sandbox exists, at its lease mode, served per-Exec: named, so it can be looked at.
        const text = r.err instanceof ApiError ? describeError(r.err) : setModeFailureText(r.err);
        if (c.json) c.io.out(JSON.stringify({ ...s, setMode: { error: text } }) + '\n');
        else c.io.out(`${id}\n`);
        c.io.err(
          `sbx: ${id}: created, but its mode was not sent${o.seed ? '; the seed was not run' : ''}`,
        );
        if (r.err instanceof ApiError) return failed(c, r.err);
        c.io.err(`sbx: ${text}`);
        return SBX_EXIT.failed;
      }
      c.io.err(
        r.outcome === 'pending'
          ? `sbx: ${pendingText(id, r.code)}`
          : `mode ${s.mode} (epoch ${s.modeEpoch})`,
      );
      // In --json too, so a script can tell a lease applied from one pending.
      setMode =
        r.outcome === 'pending' ? { outcome: 'pending', code: r.code } : { outcome: 'applied' };
    }
    const withSetMode = setMode ? { setMode } : {};
    let seeded: SeedResult | undefined;
    if (o.seed) {
      const r = await seedSandbox(c, s, o.factory).catch((err: unknown) =>
        err instanceof ApiError ? Promise.reject(err) : sandboxFailureText(err),
      );
      if (typeof r === 'string') {
        if (c.json) c.io.out(JSON.stringify({ ...s, ...withSetMode, seed: { error: r } }) + '\n');
        else c.io.out(`${id}\n`);
        c.io.err(`sbx: ${id}: ${r}`);
        return SBX_EXIT.failed;
      }
      seeded = r;
      c.io.err(
        r.seed === ''
          ? `${id}: the template has no seed`
          : `seeded ${id}${r.head ? `: a clean tree at ${r.head}` : ''}`,
      );
    }
    if (c.json) {
      c.io.out(
        JSON.stringify({ ...s, ...withSetMode, ...(seeded ? { seed: seeded } : {}) }) + '\n',
      );
    } else c.io.out(`${id}\n`);
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** A lease create's set_mode: a token minted for the record's mode and epoch, sent once (M8). */
async function sendCreatedMode(
  c: SbxCtx,
  id: string,
  factory: ExecFactory | undefined,
): Promise<SetModeOutcome> {
  const x = await openExec(c, id, factory);
  try {
    const { setModeToken } = await c.api.mintSandboxModeToken(id);
    return await sendSetMode(x, c.api, id, setModeToken, c.signal);
  } finally {
    x.close();
  }
}

function stateText(s: SbxSandbox): string {
  if (s.state !== 'terminated') return s.state;
  return s.reason ? `terminated (${s.reason})` : 'terminated';
}

/**
 * A sandbox name as the control plane accepts one at create (`sandbox-handlers.ts` NAME_RE).
 * Checked before the name is looked up, so an argument that is neither an id nor a name (a path,
 * say) is a usage error with no request made.
 */
export const SANDBOX_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The id of the caller's live sandbox named `name` (`create --name`/`up --name`), or the exit
 * code after saying why there is none. The control plane keeps names unique among one owner's
 * live sandboxes, so one match is the answer; a terminated one of the name is not (it takes no
 * more commands, and a new one may reuse its name). The match's id is checked as an id typed
 * would be: it goes into URLs, the flight recorder's file name and Codex's TOML override.
 */
export async function resolveSandboxName(c: SbxCtx, name: string): Promise<string | number> {
  let ss: SbxSandbox[];
  try {
    ss = await c.api.listSandboxes();
  } catch (err) {
    return failed(c, err);
  }
  const live = ss.filter((s) => s.name === name && s.state === 'ready');
  if (live.length === 1) {
    const found = live[0]!.id;
    if (SANDBOX_ID_RE.test(found)) return found;
    c.io.err(
      `sbx: the control plane answered '${sanitizeRemote(name)}' with '${sanitizeRemote(found)}', which is not a sandbox id (sbx-…)`,
    );
    return SBX_EXIT.failed;
  }
  if (live.length === 0) {
    c.io.err(`sbx: you have no live sandbox named '${sanitizeRemote(name)}' (see mocactl sbx ls)`);
  } else {
    const ids = live.map((s) => sanitizeRemote(s.id)).join(', ');
    c.io.err(
      `sbx: more than one live sandbox is named '${sanitizeRemote(name)}': ${ids}; use its id`,
    );
  }
  return SBX_EXIT.failed;
}

/**
 * EXPIRES: a live sandbox's deadline, `in 6 d`; an ended one's end, `ended 2 h ago`, or just
 * `ended` when the record says no end time and its deadline is still ahead (a control plane that
 * leaves terminatedAt null), rather than a time it cannot know.
 */
function expiryText(s: SbxSandbox, nowS: number): string {
  if (s.state !== 'terminated') {
    // A live record past its deadline is clock skew: the control plane's state wins.
    return relativeText(Math.max(s.expiresAt, nowS), nowS);
  }
  const end = s.terminatedAt ?? (s.expiresAt <= nowS ? s.expiresAt : undefined);
  return end === undefined ? 'ended' : `ended ${relativeText(Math.min(end, nowS), nowS)}`;
}

/**
 * `sbx ls`. A deleted sandbox is left out, in the table and in --json alike, unless
 * `includeDeleted`: it was ended on purpose, so it is noise in a list of what one has. An expired
 * one stays, since nobody chose to end it. EXPIRES is relative: a live sandbox's deadline, an
 * ended one's end. The idle lifetime is `sbx get`'s.
 */
export async function cmdLs(
  c: SbxCtx,
  all: boolean,
  o: { includeDeleted?: boolean } = {},
): Promise<number> {
  try {
    const ss = (await c.api.listSandboxes({ all })).filter(
      (s) => o.includeDeleted || !(s.state === 'terminated' && s.reason === 'deleted'),
    );
    if (c.json) {
      c.io.out(JSON.stringify(ss) + '\n');
      return SBX_EXIT.ok;
    }
    const nowS = Math.floor((c.now ?? c.rt.now)() / 1000);
    // No header for an empty list, so "nothing" stays empty output.
    if (ss.length === 0) return SBX_EXIT.ok;
    const header = [
      'ID',
      'NAME',
      'TEMPLATE',
      'MODE',
      'STATE',
      'EXPIRES',
      ...(all ? ['OWNER'] : []),
    ];
    // Sanitized before measuring, so stripped control characters cannot skew the columns.
    const rows = ss.map((s) =>
      [
        s.id,
        s.name ?? '-',
        s.template,
        s.mode,
        stateText(s),
        expiryText(s, nowS),
        ...(all ? [s.owner] : []),
      ].map(sanitizeRemote),
    );
    c.io.out(columns(header, rows));
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/**
 * `sbx rm`. `goneOk`: the id is the repository's bound sandbox, so one the control plane no longer
 * knows (purged after its retention) is "already gone" (exit 0), and `rm` can still take back
 * the configuration `up` wrote. Any other id's 404 is the failure it was. Before the DELETE, a lease
 * sandbox's lease is ended (`sandbox_deleted`), so its guest does not outlive the record, and every
 * sandbox's workspace is released on its worker (#338), so its standbys and disk go at once. A
 * released workspace takes no more Execs, so when the DELETE then fails, `rm` says so: the sandbox
 * still exists, and re-running `rm` finishes the job.
 */
export async function cmdRm(
  c: SbxCtx,
  id: string,
  o: { goneOk?: boolean; factory?: ExecFactory } = {},
): Promise<number> {
  const released = await endOnWorker(c, id, o.factory);
  if (c.signal?.aborted) {
    c.io.err(`sbx: interrupted (exit ${SBX_EXIT.interrupted}): nothing was deleted`);
    if (released !== 'none') c.io.err(releasedNotDeleted(id, released));
    return SBX_EXIT.interrupted;
  }
  try {
    const r = await c.api.deleteSandbox(id);
    forgetNotices(c.rt.paths.stateDir, id);
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
      forgetNotices(c.rt.paths.stateDir, id);
      if (c.json) c.io.out(JSON.stringify({ id, state: 'terminated', reason: 'gone' }) + '\n');
      c.io.err(`${id} is already gone (the control plane no longer has it)`);
      return SBX_EXIT.ok;
    }
    const code = failed(c, err);
    if (released !== 'none') c.io.err(releasedNotDeleted(id, released));
    return code;
  }
}

/**
 * `sbx egress`: a sandbox's egress, as its KVM host's proxy logged it. Text: the
 * summary per host, then whether the log is complete, whether it is sealed (final: the control
 * plane takes no more events, 600 s after the sandbox ended) and its digest. `--json`: every event and the
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
      if (c.io.outBytes) c.io.outBytes(body);
      else c.io.out(body.toString('utf8'));
      return SBX_EXIT.ok;
    }
    let page = await c.api.sandboxEgress(id, { limit: 1000 });
    // The summary comes on the first page only (the control plane computes it once, there).
    const summary = page.summary;
    if (!summary) {
      c.io.err('sbx: the control plane sent no egress summary on the first page');
      return SBX_EXIT.failed;
    }
    if (c.json) {
      const events = [...page.events];
      // A server that hands out a `next` it handed out before would loop forever: refused.
      const seen = new Set<string>();
      while (page.next !== null) {
        if (seen.has(page.next)) {
          c.io.err("sbx: the control plane repeated an egress page's next; the log was not read");
          return SBX_EXIT.failed;
        }
        seen.add(page.next);
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
        .map(([d, n]) => `${sanitizeRemote(d)} ${num(n)}`)
        .join(', ');
      c.io.out(
        `${sanitizeRemote(host || '-').padEnd(40)} ${num(h.count).padStart(6)}  ` +
          `up ${num(h.bytesUp)} B, down ${num(h.bytesDown)} B  (${decisions})\n`,
      );
    }
    c.io.out(
      `${num(summary.total)} events; ` +
        (summary.complete ? 'complete' : `INCOMPLETE: ${num(summary.dropped)} dropped`) +
        sealedText(summary.sealed) +
        `; ${sanitizeRemote(String(summary.sha256))}\n`,
    );
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/**
 * How long `rm` waits on the worker before its DELETE: `sandbox_deleted` may block up to the
 * worker's grace limit (30 min), but the worker finishes the op once started, so `rm` stops waiting
 * and deletes. A release is answered at once.
 */
const RM_LEASE_WAIT_MS = 15_000;

/** After a release whose DELETE did not happen: the sandbox is still there, its workspace gone. */
function releasedNotDeleted(id: string, released: 'took' | 'unknown'): string {
  return released === 'took'
    ? `sbx: ${id}'s workspace was released on its worker but the sandbox still exists: ` +
        `re-run \`mocactl sbx rm ${id}\``
    : // The release frame may be on the worker's stream already (the relay writes it before it waits):
      // a cancelled or timed-out call only drops the answer.
      `sbx: ${id}'s workspace may have been released on its worker (the release got no answer); ` +
        `if it was, the sandbox takes no more commands until it is deleted: re-run \`mocactl sbx rm ${id}\``;
}

/**
 * What `rm` knows about its release: `took` (the worker released it or will when its Exec ends),
 * `unknown` (the call ended without an answer: cancelled, timed out or unavailable, so the worker
 * may hold it; an unavailable relay may also have sent nothing, which the "may" covers), or `none`
 * (not sent, refused, an unknown key, or a worker without release).
 */
type ReleaseKnown = 'took' | 'unknown' | 'none';

/** A release error whose call may have reached the worker: no answer came back. */
function releaseAnswerLost(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'cancelled' || code === 'timeout' || code === 'unavailable';
}

/**
 * Before a sandbox's DELETE, on its worker (spec §4.1, #338): a lease sandbox's `LeaseControl
 * sandbox_deleted`, then a Release of the sandbox's workspace for every sandbox, so the worker
 * frees its standbys and workspace now rather than at idle reclaim. Best-effort: any error (the
 * record, the token, a call, a worker that predates release) is ignored and the DELETE goes ahead,
 * as it does after RM_LEASE_WAIT_MS. The bound covers the whole step: the record read, the token
 * mint and the dial, then the calls (spec §8.3). Ctrl-C cancels it at any point (the caller then
 * deletes nothing). Returns `took`, `unknown` or `none` (ReleaseKnown): after `took`, the
 * workspace takes no more Execs whatever the DELETE does; after `unknown`, it may not.
 */
async function endOnWorker(
  c: SbxCtx,
  id: string,
  factory: ExecFactory | undefined,
): Promise<ReleaseKnown> {
  const waited = new AbortController();
  const settled = new AbortController();
  void (c.sleep ?? c.rt.sleep)(RM_LEASE_WAIT_MS, settled.signal).then(() => {
    if (!settled.signal.aborted) waited.abort();
  });
  const signal = c.signal ? AbortSignal.any([c.signal, waited.signal]) : waited.signal;
  try {
    const leased = modeRank((await c.api.getSandbox(id, { signal })).mode) > 0;
    // Deleting is not use: the mint does not move the idle deadline.
    const x = await openExec(c, id, factory, { signal, activity: false });
    try {
      if (leased) {
        try {
          await x.leaseControl('sandbox_deleted', undefined, { signal });
        } catch {
          // The release still goes: it frees what it can.
        }
      }
      if (signal.aborted) return 'none';
      try {
        return (await x.release({ signal })) === 'unknown_key' ? 'none' : 'took';
      } catch (err) {
        return releaseAnswerLost(err) ? 'unknown' : 'none';
      }
    } finally {
      x.close();
    }
  } catch {
    // Best-effort: the DELETE decides, and reports its own failure.
    return 'none';
  } finally {
    settled.abort();
  }
}

/**
 * `sbx egress ID --verify`: the log as served, its sha256 and line count checked against the
 * control plane's summary of the same log. That catches damage in transit and a server whose log
 * and summary disagree; it does not read the sandbox's end record (an owner cannot read provenance
 * records: verify-provenance.py --egress checks a saved copy against an export). The log is read
 * first and the summary after, so an open log (not yet sealed) that gained events in between shows
 * as such, not as damage. Exit 0 only when both match.
 */
async function verifyEgress(c: SbxCtx, id: string): Promise<number> {
  const body = await c.api.sandboxEgressNdjson(id);
  const summary = (await c.api.sandboxEgress(id, { limit: 1 })).summary;
  if (!summary) {
    c.io.err('sbx: the control plane sent no egress summary on the first page');
    return SBX_EXIT.failed;
  }
  const sha256 = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  let lines = 0;
  for (const b of body) if (b === 0x0a) lines += 1;
  const whole = body.length === 0 || body[body.length - 1] === 0x0a;
  const ok = whole && sha256 === summary.sha256 && lines === summary.total;
  // An open log that grew between the two reads: more events in the summary than were read.
  const grew =
    !ok && summary.sealed !== true && typeof summary.total === 'number' && summary.total > lines;
  if (c.json)
    c.io.out(
      JSON.stringify({
        verified: ok,
        sha256,
        lines,
        summary: {
          sha256: summary.sha256,
          total: summary.total,
          complete: summary.complete,
          sealed: summary.sealed,
        },
        ...(grew ? { open: true } : {}),
      }) + '\n',
    );
  else if (ok)
    c.io.out(
      `verified: ${lines} events, ${sanitizeRemote(sha256)}` +
        (summary.complete ? '' : `; INCOMPLETE: ${num(summary.dropped)} dropped`) +
        sealedText(summary.sealed) +
        '\n',
    );
  else if (grew)
    c.io.out(
      `NOT verified: the log is still open (not sealed) and gained events while it was read ` +
        `(${lines} read, ${num(summary.total)} now); run --verify again, or once it is sealed ` +
        `(10 minutes after the sandbox ends)\n`,
    );
  else
    c.io.out(
      `NOT verified: the log served is ${lines} events, ${sanitizeRemote(sha256)}; ` +
        `the summary names ${num(summary.total)}, ${sanitizeRemote(String(summary.sha256))}\n`,
    );
  return ok ? SBX_EXIT.ok : SBX_EXIT.failed;
}

/** A number from the server, printed only when it is one: anything else is `?`, never its text. */
function num(x: unknown): string {
  return typeof x === 'number' && Number.isFinite(x) ? String(x) : '?';
}

/** `; sealed` or `; open (not sealed yet)`; nothing from a server that does not say. */
function sealedText(sealed: boolean | undefined): string {
  if (sealed === undefined) return '';
  return sealed ? '; sealed' : '; open (not sealed yet)';
}

/**
 * `sbx token`: a fresh sandbox token on stdout. With `renewEveryS`, a new one every S seconds, one
 * line each, until stopped (the signal; exit 0), so a long-lived client can read its next token
 * from a pipe rather than run mocactl again.
 *
 * `--json` adds the token's own `expiresAt` and the sandbox's `sandboxExpiresAt`, as the control
 * plane sent them. The sandbox's deadline slides with activity, and each mint counts as activity,
 * so a client holding a token learns from every line when the sandbox itself will end, which the
 * token's own short expiry doesn't show (the token never outlives it: it is capped at the
 * sandbox's deadline when minted). A control plane from before the field sends none, and the line
 * then has none either: absent, never a made-up value.
 */
export async function cmdToken(c: SbxCtx, id: string, renewEveryS?: number): Promise<number> {
  try {
    for (;;) {
      const t = await c.api.mintSandboxToken(id);
      const json = {
        token: t.token,
        expiresAt: t.expiresAt,
        ...(t.sandboxExpiresAt !== undefined ? { sandboxExpiresAt: t.sandboxExpiresAt } : {}),
      };
      c.io.out((c.json ? JSON.stringify(json) : t.token) + '\n');
      if (renewEveryS === undefined) return SBX_EXIT.ok;
      await (c.sleep ?? c.rt.sleep)(renewEveryS * 1000, c.signal);
      if (c.signal?.aborted) return SBX_EXIT.ok;
    }
  } catch (err) {
    if (c.signal?.aborted) return SBX_EXIT.ok;
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
function tokenCmd(explicitUrl: string | undefined, id: string): string {
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
    // No command runs on this token and it is never printed: not the owner's use (#770).
    const t = await c.api.mintSandboxToken(id, { activity: false });
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

/** The API token issuer each profile's control plane mints under (control-plane token.ts). */
const ISSUER_BY_PROFILE: Record<string, string> = {
  sandbox: 'sbx-control-plane-api',
};

/** A JWT's `iss`, read WITHOUT verifying it: only to compare. */
function jwtIssuer(token: string): string | undefined {
  try {
    const c = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      iss?: unknown;
    };
    return typeof c.iss === 'string' ? c.iss : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Before an admin write: the login must be for this control plane, and its token minted under the
 * issuer this control plane's profile mints under -- a login for one deployment pointed at another
 * is refused here, before the read and the write. A token whose `iss` cannot be read (not a JWT) is
 * left to the control plane to judge. Returns the refusal line.
 */
async function loginMismatch(c: SbxCtx): Promise<string | undefined> {
  const auth = c.rt.auth;
  if (!auth) return undefined;
  if (!sameControlPlane(auth.controlPlaneUrl, c.url))
    return `the login is for ${sanitizeRemote(auth.controlPlaneUrl)}, not ${sanitizeRemote(c.url)}`;
  const iss = jwtIssuer(auth.apiToken);
  if (iss === undefined) return undefined;
  const d: SbxDiscovery = await c.api.sandboxDiscovery();
  const want = ISSUER_BY_PROFILE[d.profile ?? ''];
  if (want !== undefined && iss !== want)
    return `the login was issued by '${sanitizeRemote(iss)}', but ${sanitizeRemote(c.url)} (profile ${sanitizeRemote(d.profile ?? 'harness')}) issues '${want}': it is another deployment's login`;
  return undefined;
}

const quotaText = (q: SbxQuota | null | undefined) =>
  q
    ? `templates ${q.templates}, builds queued ${q.buildsQueued}, active ${q.active}` +
      (q.owned !== undefined ? `, owned ${q.owned}` : '')
    : 'the default';

/**
 * The counters of a quota, and nothing else: what a quota write sends as `?expect=`. The control
 * plane refuses an expect with another key, and a deployment-wide quota stored through
 * `PUT /v1/policy` (or by an older control plane) may carry one.
 */
const quotaCounters = (q: SbxQuota | null): SbxQuota | null =>
  q && {
    templates: q.templates,
    buildsQueued: q.buildsQueued,
    active: q.active,
    ...(q.owned !== undefined ? { owned: q.owned } : {}),
  };

/**
 * `sbx templates quota TARGET (--templates N --builds-queued N --active N [--owned N] | --clear)` (template
 * lifecycle spec §5.2; admins). Names the control plane it writes to and refuses a login issued for
 * another deployment; reads the current value first (`GET /v1/policy`), then writes it as a
 * compare-and-set (`?expect=`, the counters read as percent-encoded JSON, `null` for no override):
 * if another admin changed the quota in between, the control plane writes nothing (`409 quota_changed`), and this reports the value now (exit 1).
 * Prints old -> new (new as the control plane stored it: without --owned, the target keeps its
 * owned) and the new policy's digest and record.
 */
export async function cmdSetQuota(
  c: SbxCtx,
  target: string,
  quota: SbxQuota | null,
): Promise<number> {
  try {
    const mismatch = await loginMismatch(c);
    if (mismatch) {
      c.io.err(`sbx: refused: ${mismatch}`);
      return SBX_EXIT.failed;
    }
    c.io.err(`sbx: admin write to ${sanitizeRemote(c.url)}`);
    const pol = (await c.api.getPolicy()).policy;
    const read = target === 'default' ? pol.quota : (pol.quotaBySubject?.[target] ?? null);
    let r: Awaited<ReturnType<typeof c.api.putQuota>>;
    try {
      r = await c.api.putQuota(target, quota, quotaCounters(read));
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'quota_changed') throw err;
      const p2 = (await c.api.getPolicy()).policy;
      const now = target === 'default' ? p2.quota : (p2.quotaBySubject?.[target] ?? null);
      c.io.err(
        `sbx: nothing written: ${sanitizeRemote(target)}'s quota was changed by someone else after ` +
          `this command read it (read ${quotaText(read)}, now ${quotaText(now)}): check it, then run ` +
          'the command again',
      );
      return SBX_EXIT.failed;
    }
    if (c.json) c.io.out(JSON.stringify({ ...r, read }) + '\n');
    else
      c.io.out(
        `${sanitizeRemote(r.target)}: ${quotaText(read)} -> ${quota === null ? 'the default' : quotaText(r.quota ?? quota)}` +
          ` (policy ${sanitizeRemote(r.policy)}, record ${sanitizeRemote(r.record)})\n`,
      );
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** The loud failure of an admin write: the value changed between this command's read and its write. */
function raced(c: SbxCtx, what: string, read: string, before: string, now: string): number {
  c.io.err(
    `sbx: ${what} was changed by someone else between read and write: ${read} / ${before} / ${now} ` +
      '(read / before this write / now): check it, and write again if need be',
  );
  return SBX_EXIT.failed;
}

/** One subject, for a person: `github:9  enrolled (api)  admin (api, until 2026-11-08T12:00:00Z)`. */
function subjectLine(s: SbxSubject): string {
  const roles = s.roles.map(
    (r) =>
      `${sanitizeRemote(r.role)} (${r.source}${r.until !== null ? `, until ${new Date(r.until * 1000).toISOString().replace('.000Z', 'Z')}` : ''})`,
  );
  return [
    sanitizeRemote(s.subject),
    `${s.enrolled ? 'enrolled' : 'not enrolled'} (${s.source}${s.source === 'env' && s.storeEnrolled ? ', api too' : ''})`,
    ...roles,
  ].join('  ');
}

/** `sbx admin subjects`: every enrolled subject and its roles (admins). */
export async function cmdSubjects(c: SbxCtx): Promise<number> {
  try {
    const subjects = await c.api.listSubjects();
    if (c.json) c.io.out(JSON.stringify(subjects) + '\n');
    else for (const s of subjects) c.io.out(subjectLine(s) + '\n');
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** An API-granted admin role's state: `none`, or `admin` with its `until` (null: no expiry). */
const roleOf = (s: SbxSubject | undefined) => {
  const r = s?.roles.find((x) => x.role === 'admin' && x.source === 'api');
  return r ? `admin until ${r.until ?? 'no expiry'}` : 'none';
};

/**
 * Whether the subject read is already in the state the action asks for, so the write should change
 * nothing (`record: null`); undefined where the list cannot tell. Enrollment compares the store's
 * own enrollment (`storeEnrolled`), not `enrolled`, which folds in the settings and an admin role:
 * the control plane answers an enroll of a settings subject unchanged, and refuses its unenroll.
 */
function alreadyThere(
  action: 'enroll' | 'unenroll' | 'grant' | 'revoke',
  s: SbxSubject | undefined,
  until?: number,
): boolean | undefined {
  switch (action) {
    case 'enroll':
      return s?.source === 'env' || s?.storeEnrolled === true;
    case 'unenroll':
      return s?.source === 'env' ? undefined : s?.storeEnrolled !== true;
    case 'grant':
      return roleOf(s) === `admin until ${until ?? 'no expiry'}`;
    case 'revoke':
      // A lapsed grant is listed as none, yet a revoke still records its removal: "none" tells nothing.
      return roleOf(s) === 'none' ? undefined : false;
  }
}

/**
 * `sbx admin subjects enroll|unenroll|grant|revoke SUBJECT` (an admin named in the
 * settings). The subjects are read first, the change written, and the answer compared with the
 * read. These answers name no `before`; their `record` does the same work (null when nothing
 * changed), so a read that says "already so" with a record written, or "to change" with none, is a
 * concurrent write, reported loudly (exit 1). Prints old -> new and the record's digest.
 */
export async function cmdSubjectChange(
  c: SbxCtx,
  action: 'enroll' | 'unenroll' | 'grant' | 'revoke',
  subject: string,
  until?: number,
): Promise<number> {
  try {
    const mismatch = await loginMismatch(c);
    if (mismatch) {
      c.io.err(`sbx: refused: ${mismatch}`);
      return SBX_EXIT.failed;
    }
    c.io.err(`sbx: admin write to ${sanitizeRemote(c.url)}`);
    const read = (await c.api.listSubjects()).find((s) => s.subject === subject);
    const r =
      action === 'enroll'
        ? await c.api.enrollSubject(subject)
        : action === 'unenroll'
          ? await c.api.unenrollSubject(subject)
          : action === 'grant'
            ? await c.api.grantAdmin(subject, until)
            : await c.api.revokeAdmin(subject);
    const state = (s: SbxSubject | undefined) =>
      action === 'enroll' || action === 'unenroll'
        ? s?.enrolled
          ? `enrolled (${s.source})`
          : 'not enrolled'
        : roleOf(s);
    if (c.json) c.io.out(JSON.stringify({ ...r, read: read ?? null }) + '\n');
    else
      c.io.out(
        `${subjectLine(r)}${r.record ? '' : '  (unchanged)'}\n` +
          `${sanitizeRemote(subject)}: ${state(read)} -> ${state(r)}${r.record ? ` (record ${sanitizeRemote(r.record)})` : ''}\n`,
      );
    const there = alreadyThere(action, read, until);
    if (there !== undefined && there !== (r.record === null))
      return raced(
        c,
        `${subject}'s ${action === 'enroll' || action === 'unenroll' ? 'enrollment' : 'admin role'}`,
        state(read),
        r.record === null ? 'already so' : 'changed by this write',
        state(r),
      );
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}
