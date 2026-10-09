import { ApiError } from './api/errors.js';
import type { CredentialConsumer, SessionSummary } from './api/types.js';
import {
  LoginCancelledError,
  LoginExpiredError,
  apiTokenValid,
  codeValidity,
  deviceLogin,
  toCachedAuth,
} from './core/auth.js';
import {
  credentialProblem,
  credentialRequest,
  descriptionProblem,
  secretFromStdin,
} from './core/credential-checks.js';
import { formatDiagnostics, runDiagnostics } from './core/diagnostics.js';
import { describeError } from './core/messages.js';
import { PromoteError, promoteDirectory, type PromoteSummary } from './core/promote.js';
import { sanitizeRemote } from './core/sanitize.js';
import { SessionManager, type ActiveSession } from './core/session-manager.js';
import {
  SESSION_OPTION_FIELDS,
  fieldRefusedByServer,
  resolveSessionOptions,
} from './core/session-options.js';
import { workspaceResetText } from './render/blocks.js';
import { ensureRuntimeAuth, sessionManager, setAuth, type Runtime } from './runtime.js';

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

// Only the control plane is required: it says where the harness is (GET /v1/discovery).
const MISSING = {
  controlPlaneUrl:
    'missing control-plane URL — pass --control-plane-url or set SH_CONTROL_PLANE_URL',
};

function missing(rt: Runtime, io: Io, need: Array<keyof typeof MISSING>): boolean {
  const absent = need.filter((k) => !rt.endpoints[k]);
  for (const k of absent) io.err(MISSING[k]);
  return absent.length > 0;
}

export async function cmdLogin(rt: Runtime, io: Io, signal?: AbortSignal): Promise<number> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp) return 2;
  try {
    const login = await deviceLogin(
      { cp: rt.cp, sleep: rt.sleep, now: rt.now },
      (s, attempt) =>
        io.err(
          `${attempt > 1 ? 'That code expired. ' : ''}Open ${sanitizeRemote(s.verificationUri)} ` +
            `and enter the code ${sanitizeRemote(s.userCode)} (valid for ${codeValidity(s.expiresIn)})`,
        ),
      signal,
    );
    setAuth(rt, toCachedAuth(login, rt.endpoints.controlPlaneUrl!));
    io.err(`logged in as ${login.displayName ?? login.subject}`);
    return 0;
  } catch (err) {
    if (err instanceof LoginCancelledError) return 130;
    if (err instanceof LoginExpiredError) {
      // The re-issued code lapsed too: nobody is at the browser, so a third code would only wait.
      io.err('login failed: the code expired before it was approved — run `mocactl login` again');
      return 1;
    }
    io.err(`login failed: ${describeError(err)}`);
    return 1;
  }
}

/** `mocactl auth token`'s exit codes beyond 0 and 2: the Claude Code hook branches on them. */
export const AUTH_EXIT = { loginRequired: 3, unreachable: 4 } as const;

/**
 * Print a valid API token, refreshing it if needed; never prompts (B14 spec §5.3). This is the whole
 * contract for the Claude Code hook: it never reads auth.json, whose format stays mocactl's own.
 */
export async function cmdAuthToken(rt: Runtime, io: Io, json: boolean): Promise<number> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp) return 2;
  const r = await ensureRuntimeAuth(rt);
  if (r.kind === 'login_required') {
    io.err('not logged in — run `mocactl login`');
    return AUTH_EXIT.loginRequired;
  }
  if (r.kind === 'unreachable') {
    io.err(`cannot refresh the login: ${describeError(r.error)}`);
    return AUTH_EXIT.unreachable;
  }
  const { apiToken, expiresAt, subject } = r.auth;
  io.out((json ? JSON.stringify({ token: apiToken, expiresAt, subject }) : apiToken) + '\n');
  return 0;
}

/**
 * End the login on the server, then locally. The local file goes even when the server cannot be
 * told -- the user asked to be logged out of THIS machine -- and the message says what that leaves.
 */
export async function cmdLogout(rt: Runtime, io: Io, opts: { all: boolean }): Promise<number> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp) return 2;
  const auth = rt.auth;
  if (!auth) {
    io.err('not logged in');
    return 0;
  }
  try {
    if (opts.all) {
      await ensureRuntimeAuth(rt); // revoke-all takes an API token; refresh one first if needed
      const n = await rt.cp.revokeAllAuth();
      io.err(`logged out: ${n} ${n === 1 ? 'login' : 'logins'} revoked`);
    } else if (auth.refreshToken) {
      await rt.cp.revokeAuth(auth.refreshToken);
      io.err('logged out');
    } else {
      io.err('logged out (this login predates refresh tokens; nothing to revoke)');
    }
  } catch (err) {
    setAuth(rt, null);
    io.err(
      `logged out of this machine, but the control plane did not confirm: ${describeError(err)} — ` +
        'the login stays valid there until it expires; to end it now, run `mocactl login` and then `mocactl logout --all`',
    );
    return 1;
  }
  setAuth(rt, null);
  return 0;
}

export async function cmdDoctor(rt: Runtime, io: Io, json: boolean): Promise<number> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp || !rt.harness) return 2;
  const results = await runDiagnostics({
    cp: rt.cp,
    harness: rt.harness,
    controlPlaneUrl: rt.endpoints.controlPlaneUrl!,
    harnessOverridden: rt.endpoints.harnessUrl !== undefined,
    loggedIn: apiTokenValid(rt.auth, rt.now()),
  });
  io.out((json ? JSON.stringify(results) : formatDiagnostics(results)) + '\n');
  if (!json && rt.auth?.refreshExpiresAt) {
    const until = new Date(rt.auth.refreshExpiresAt * 1000).toISOString().slice(0, 10);
    io.out(`login renews without asking until ${until} (\`mocactl logout\` ends it)\n`);
  }
  return results.every((r) => r.status === 'pass') ? 0 : 1;
}

export interface RunOptions {
  prompt: string;
  session?: string;
  options: Record<string, string>;
  json: boolean;
  signal?: AbortSignal;
  configRef?: string;
}

/** False (with the reason on stderr) unless there is a control plane and a valid login for it. */
function ready(rt: Runtime, io: Io): rt is Runtime & Required<Pick<Runtime, 'cp' | 'harness'>> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp || !rt.harness) return false;
  if (!apiTokenValid(rt.auth, rt.now())) {
    io.err(
      rt.auth?.refreshToken
        ? 'the login could not be refreshed — is the control plane reachable? (`mocactl doctor`)'
        : 'not logged in — run `mocactl login` first',
    );
    return false;
  }
  return true;
}

export async function cmdPromote(
  rt: Runtime,
  io: Io,
  opts: { dir: string; json: boolean; dryRun?: boolean },
): Promise<number> {
  if (!opts.dryRun && !ready(rt, io)) return 2;
  try {
    // Printed BEFORE the upload, so a possible_secret or skipped-symlink warning is seen first.
    const onBuilt = (r: PromoteSummary) => {
      if (opts.json) {
        if (r.report.trim()) io.err(r.report);
        return;
      }
      io.out(`config root  ${r.configRoot}\n`);
      io.out(`skills       ${r.skills.join(', ') || 'none'}\n`);
      for (const d of r.dropped) io.out(`dropped      ${d.name}  (${d.reason})\n`);
      io.out(`commands     ${r.prompts.join(', ') || 'none'}\n`);
      if (r.report.trim()) io.err(r.report);
    };
    const r = await promoteDirectory(opts.dir, rt.cp, {}, { onBuilt, dryRun: opts.dryRun });
    if (opts.json) {
      io.out(JSON.stringify(r) + '\n');
      return 0;
    }
    if (r.dryRun) {
      io.out(`bundle       ${r.digest}  (dry run: not uploaded)\n`);
      return 0;
    }
    io.out(`bundle       ${r.digest}  (${r.uploaded ? 'uploaded' : 'unchanged'})\n`);
    io.out(`start a session with:  mocactl run "…" --config ${r.digest}\n`);
    return 0;
  } catch (err) {
    if (err instanceof PromoteError) {
      io.err(err.message);
      return err.exitCode;
    }
    io.err(describeError(err));
    return 1;
  }
}

export async function cmdBundleDelete(
  rt: Runtime,
  io: Io,
  opts: ManageOptions & { digest: string },
): Promise<number> {
  if (!/^sha256:[0-9a-f]{64}$/.test(opts.digest)) {
    io.err('a bundle digest is sha256:<64 lowercase hex>, as `mocactl promote` prints it');
    return 2;
  }
  if (!ready(rt, io)) return 2;
  try {
    await cancellable(rt.cp.deleteConfigBundle(opts.digest), opts.signal);
  } catch (err) {
    // Not describeError's "this session's bundle is gone" advice: here no session is involved.
    if (err instanceof ApiError && err.code === 'config_bundle_not_found') {
      io.err(`no config bundle with digest ${opts.digest}`);
      return 1;
    }
    if (err instanceof ApiError && err.code === 'forbidden') {
      io.err(sanitizeRemote(err.message));
      return 1;
    }
    return failed(io, err);
  }
  io.err(`deleted config bundle ${opts.digest}`);
  if (opts.json) io.out(JSON.stringify({ digest: opts.digest, status: 'deleted' }) + '\n');
  return 0;
}

export async function cmdRun(rt: Runtime, io: Io, opts: RunOptions): Promise<number> {
  if (!ready(rt, io)) return 2;
  const manager = new SessionManager({
    cp: rt.cp,
    harness: rt.harness,
    transcripts: rt.transcripts,
    now: rt.now,
    sleep: rt.sleep,
  });

  let session: ActiveSession;
  try {
    if (opts.session) {
      session = await manager.resume(opts.session);
    } else {
      const r = await resolveSessionOptions(
        rt.cp,
        SESSION_OPTION_FIELDS,
        opts.options,
        rt.config.lastUsed,
        { interactive: false },
      );
      if (r.status === 'blocked') {
        io.err(`cannot start a session: ${r.field.emptyHint}`);
        return 2;
      }
      if (r.status === 'needs-input') {
        const label = r.field.label.toLowerCase();
        const declared = r.choices.map((c) => sanitizeRemote(c.value)).join(', ');
        const given = opts.options[r.field.key];
        // A value given with --option but not among the choices is named as rejected, not asked for
        // again as though none had been given. It is user input echoed to a terminal, so sanitized.
        io.err(
          given !== undefined
            ? `unknown ${label} '${sanitizeRemote(given)}'; declared: ${declared}`
            : `choose the ${label} with --option ${r.field.key}=<value>: ${declared}`,
        );
        return 2;
      }
      try {
        session = await manager.create(
          opts.configRef !== undefined ? { ...r.request, configRef: opts.configRef } : r.request,
        );
      } catch (err) {
        const refused = fieldRefusedByServer(err, SESSION_OPTION_FIELDS);
        if (!refused) throw err;
        io.err(`cannot start a session: ${refused.emptyHint}`);
        return 2;
      }
    }
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }

  io.err(`session ${session.sessionId}`);
  if (opts.json) io.out(JSON.stringify({ type: 'session', sessionId: session.sessionId }) + '\n');

  // A listener added to an already-aborted signal never fires, so a cancel that lands during
  // setup (resolveSessionOptions / create / resume, all above) would otherwise be missed and the
  // turn would run anyway. Check explicitly before submitting; the session itself stays intact
  // so the user can resume it.
  if (opts.signal?.aborted) return 130;

  type Outcome = 'done' | 'error' | 'cancelled';
  let outcome: Outcome = 'done';
  let failure: Error | undefined;
  session.on((e) => {
    if (e.kind === 'frame') {
      if (opts.json) io.out(JSON.stringify(e.frame) + '\n');
      // Plain text goes straight to a terminal; JSON output escapes control characters itself.
      else if (e.frame.type === 'text') io.out(sanitizeRemote(e.frame.delta));
      // The sandbox id and tier are server-originated, so they are sanitized like the text above.
      else if (e.frame.type === 'workspace_reset')
        io.err(sanitizeRemote(workspaceResetText(e.frame)));
    } else if (e.kind === 'retrying') {
      io.err(`the harness has no capacity — retrying in ${e.seconds}s`);
    } else if (e.kind === 'turn-end') {
      outcome = e.outcome;
      failure = e.error;
    }
  });
  opts.signal?.addEventListener('abort', () => session.cancel(), { once: true });
  session.submit(opts.prompt);
  await session.idle();

  if (!opts.json) io.out('\n');
  // `outcome` is reassigned inside the `session.on` closure above, which `session.idle()`
  // guarantees has already run by this point. TypeScript's control-flow narrowing can't see
  // through the closure boundary and treats `outcome` as still the literal 'done' here, so we
  // cast back to the declared union to read its real (possibly reassigned) value.
  if ((outcome as Outcome) === 'error') {
    io.err(describeError(failure));
    return 1;
  }
  return (outcome as Outcome) === 'cancelled' ? 130 : 0;
}

// The listing and management commands below share one output convention (README "Headless"):
// stdout carries only the result (an aligned table, or one JSON document with --json), and every
// message, including "nothing to list", goes to stderr. Exit codes are those of `run`.

class Cancelled extends Error {}

/**
 * `work`, or a Cancelled rejection once `signal` aborts. The work itself is abandoned, not stopped
 * (the control-plane client takes no signal), so main.ts exits rather than wait for it.
 */
function cancellable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new Cancelled());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Cancelled());
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** The exit code for a failed request: 130 if it was cancelled, else 1 with the reason. */
function failed(io: Io, err: unknown): number {
  if (err instanceof Cancelled) return 130;
  io.err(describeError(err));
  return 1;
}

/** Columns padded to their widest cell; the last column is left ragged. */
function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

async function allSessions(rt: Runtime & { cp: NonNullable<Runtime['cp']> }) {
  const sessions: SessionSummary[] = [];
  const seen = new Set<number>();
  let cursor: number | undefined;
  for (;;) {
    const page = await rt.cp.listSessions({ limit: 200, cursor });
    sessions.push(...page.sessions);
    if (page.nextCursor === null) return sessions;
    // A cursor that comes back again would page forever.
    if (seen.has(page.nextCursor)) {
      throw new Error(`the control plane repeated the page cursor ${page.nextCursor}`);
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export interface ManageOptions {
  json: boolean;
  signal?: AbortSignal;
}

export async function cmdSessions(rt: Runtime, io: Io, opts: ManageOptions): Promise<number> {
  if (!ready(rt, io)) return 2;
  let sessions: SessionSummary[];
  try {
    sessions = await cancellable(allSessions(rt), opts.signal);
  } catch (err) {
    return failed(io, err);
  }
  // Titles are local (renamed in the TUI, or the first prompt); the control plane keeps none.
  // No turn count: the control plane reports one, but nothing writes it yet, so it is always 0.
  const rows = sessions.map((s) => ({
    sessionId: s.sessionId,
    title: rt.transcripts?.load(s.sessionId)?.title ?? null,
    state: s.state,
    createdAt: s.createdAt,
    lastTurnAt: s.lastTurnAt,
  }));
  if (opts.json) {
    io.out(JSON.stringify({ sessions: rows }) + '\n');
    return 0;
  }
  if (rows.length === 0) {
    io.err('no sessions');
    return 0;
  }
  const head = ['ID', 'STATE', 'CREATED (UTC)', 'LAST TURN (UTC)', 'TITLE'];
  const body = rows.map((r) =>
    [
      r.sessionId,
      r.state,
      utc(r.createdAt),
      r.lastTurnAt === null ? '-' : utc(r.lastTurnAt),
      r.title ?? '',
    ].map(sanitizeRemote),
  );
  io.out(table([head, ...body]) + '\n');
  return 0;
}

export async function cmdSessionDelete(
  rt: Runtime,
  io: Io,
  opts: ManageOptions & { id: string },
): Promise<number> {
  if (!ready(rt, io)) return 2;
  let status: 'deleted' | 'accepted';
  try {
    // Through the session manager, so the local history goes too.
    status = await cancellable(sessionManager(rt).remove(opts.id), opts.signal);
  } catch (err) {
    return failed(io, err);
  }
  const id = sanitizeRemote(opts.id);
  io.err(
    status === 'deleted'
      ? `deleted session ${id}`
      : `deleting session ${id}; the control plane finishes in the background`,
  );
  if (opts.json) io.out(JSON.stringify({ sessionId: opts.id, status }) + '\n');
  return 0;
}

export async function cmdCredentials(rt: Runtime, io: Io, opts: ManageOptions): Promise<number> {
  if (!ready(rt, io)) return 2;
  let rows;
  try {
    rows = (await cancellable(rt.cp.listCredentials(), opts.signal)).map((c) => ({
      name: c.name,
      kind: c.kind,
      consumer: c.consumer,
      hosts: c.destination.hosts,
      endpoint: c.endpoint ?? null,
    }));
  } catch (err) {
    return failed(io, err);
  }
  if (opts.json) {
    io.out(JSON.stringify({ credentials: rows }) + '\n');
    return 0;
  }
  if (rows.length === 0) {
    io.err('no credentials');
    return 0;
  }
  const head = ['NAME', 'KIND', 'CONSUMER', 'HOSTS', 'ENDPOINT'];
  const body = rows.map((r) =>
    [r.name, r.kind, r.consumer, r.hosts.join(','), r.endpoint ?? '-'].map(sanitizeRemote),
  );
  io.out(table([head, ...body]) + '\n');
  return 0;
}

export interface CredentialAddOptions extends ManageOptions {
  name: string;
  kind: string;
  consumer: CredentialConsumer;
  hosts: string[];
  endpoint?: string;
  /** The secret comes only from stdin, never argv, so it stays out of shell history and `ps`. */
  readStdin: () => Promise<string>;
  stdinIsTTY: boolean;
}

export async function cmdCredentialAdd(
  rt: Runtime,
  io: Io,
  opts: CredentialAddOptions,
): Promise<number> {
  if (!ready(rt, io)) return 2;
  const values = {
    name: opts.name,
    kind: opts.kind,
    consumer: opts.consumer,
    hosts: opts.hosts.join(','),
    endpoint: opts.endpoint ?? '',
  };
  // Everything but the secret is checked before stdin is read, so a typo costs no re-piping.
  // The server refuses an endpoint for any other consumer; the TUI form hides the field there.
  const early =
    opts.endpoint !== undefined && opts.consumer !== 'inference'
      ? '--endpoint only applies to --consumer inference'
      : descriptionProblem(values);
  if (early) {
    io.err(early);
    return 2;
  }
  if (opts.stdinIsTTY) {
    io.err(
      'pipe the secret on stdin, e.g. `printf %s "$KEY" | mocactl credentials add …` (or use /credentials in the TUI)',
    );
    return 2;
  }
  // Said, so a pipe with no writer yet does not look like a hang.
  io.err('reading the secret from stdin…');
  let text: string;
  try {
    text = await cancellable(opts.readStdin(), opts.signal);
  } catch (err) {
    return failed(io, err);
  }
  const read = secretFromStdin(opts.kind, text);
  if ('problem' in read) {
    io.err(read.problem);
    return 2;
  }
  const problem = credentialProblem(values, read.secret);
  if (problem) {
    io.err(problem);
    return 2;
  }
  const { name, req } = credentialRequest(values, read.secret);
  try {
    await cancellable(rt.cp.putCredential(name, req), opts.signal);
  } catch (err) {
    return failed(io, err);
  }
  io.err(`stored credential ${sanitizeRemote(name)}`);
  if (opts.json) io.out(JSON.stringify({ name, status: 'stored' }) + '\n');
  return 0;
}

export async function cmdCredentialDelete(
  rt: Runtime,
  io: Io,
  opts: ManageOptions & { name: string },
): Promise<number> {
  if (!ready(rt, io)) return 2;
  const name = sanitizeRemote(opts.name);
  try {
    // The server answers 204 for a name that never existed (no existence oracle), but the owner
    // may list their own names, so a typo in a cleanup script is reported rather than "deleted".
    const owned = await cancellable(rt.cp.listCredentials(), opts.signal);
    if (!owned.some((c) => c.name === opts.name)) {
      io.err(`no credential named ${name}`);
      return 1;
    }
    await cancellable(rt.cp.deleteCredential(opts.name), opts.signal);
  } catch (err) {
    return failed(io, err);
  }
  io.err(`deleted credential ${name}`);
  if (opts.json) io.out(JSON.stringify({ name: opts.name, status: 'deleted' }) + '\n');
  return 0;
}
