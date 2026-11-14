import { ApiError } from './api/errors.js';
import type {
  ConfigBundleSummary,
  CredentialConsumer,
  DeviceStart,
  SessionSummary,
} from './api/types.js';
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
import { sameControlPlane, storedLoginUrl } from './config.js';
import { workspaceResetText } from './render/blocks.js';
import { toolSummary } from './render/tools.js';
import { openableUrl, type OsDeps } from './os.js';
import { ensureRuntimeAuth, sessionManager, setAuth, type Runtime } from './runtime.js';

export interface Io {
  /** mocactl's own text on stdout. */
  out(s: string): void;
  /** mocactl's own messages on stderr, one line each (a newline is added). */
  err(s: string): void;
  /**
   * Bytes on stdout exactly as given: a remote command's output (`sbx run`), which may not be
   * UTF-8 and need not end in a newline. Absent: written as text through `out`.
   */
  outBytes?(b: Uint8Array): void;
  /** Bytes on stderr exactly as given, with no newline added. Absent: written through `err`. */
  errBytes?(b: Uint8Array): void;
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

/**
 * The reason a login that IS on this machine was not used: it belongs to another control plane.
 * Undefined when there is no login at all, or when the stored one is for the endpoint in use.
 *
 * Without this the gates said a bare "not logged in", so the user logged in again -- overwriting
 * the one `auth.json`, and seeing the same thing next time they switched back. That round trip is
 * what #529 was reported as ("the token only lasts an hour"); the refresh token was never sent.
 */
export function otherControlPlaneLogin(rt: Runtime): string | undefined {
  const target = rt.endpoints.controlPlaneUrl;
  if (!target) return undefined;
  const stored = storedLoginUrl(rt.paths.authFile);
  return stored && !sameControlPlane(stored, target) ? stored : undefined;
}

/** `otherControlPlaneLogin` as the clause appended to a "not logged in" line. */
function mismatchClause(rt: Runtime): string {
  const stored = otherControlPlaneLogin(rt);
  return stored
    ? ` — auth.json holds a login for ${sanitizeRemote(stored)}, but this command targets ` +
        `${sanitizeRemote(rt.endpoints.controlPlaneUrl!)}; use one URL or run \`mocactl login\``
    : '';
}

/** What a device login at this machine's own screen uses: the clipboard and the browser. */
export type LoginHelpers = Pick<OsDeps, 'copy' | 'openUrl'>;

/** How long the clipboard may take before the browser opens anyway (a helper can hang, not fail). */
export const COPY_TIMEOUT_MS = 1000;

/**
 * The shape of a device user code (GitHub's is `WDJB-MJHT`). The code comes from the server, and
 * anything else is not put on the clipboard: a hostile control plane could otherwise plant text
 * with newlines there for the user to paste into a shell.
 */
const USER_CODE = /^[A-Z0-9-]{4,16}$/;

/**
 * The device flow's prompt, on stderr: where to go and, when the provider uses one, the code to
 * enter — both sanitized, as both come from the server. Shared by `mocactl login` and
 * `mocactl sbx login`.
 *
 * A provider without a user code (the oidc flow) shows only the URL: the browser session is what
 * the person completes, so there is nothing to type.
 *
 * With `helpers` (a terminal on this machine, no --no-browser) the code is also copied to the
 * clipboard and then the page is opened, so the user only pastes and approves. GitHub's device
 * flow has no verification_uri_complete, so the code cannot ride in the URL. A clipboard that
 * fails, hangs past COPY_TIMEOUT_MS, or is handed an odd-shaped code is not an error: the
 * browser still opens and the printed code still works.
 */
export function devicePrompt(
  io: Io,
  helpers?: LoginHelpers,
): (s: DeviceStart, attempt: number) => void {
  return (s, attempt) => {
    const code = s.userCode ? ` and enter the code ${sanitizeRemote(s.userCode)}` : ' to sign in';
    io.err(
      `${attempt > 1 ? 'That sign-in window expired. ' : ''}Open ${sanitizeRemote(s.verificationUri)}${code} (valid for ${codeValidity(s.expiresIn)})`,
    );
    if (!helpers) return;
    let timer: NodeJS.Timeout | undefined;
    const copied =
      s.userCode !== undefined && USER_CODE.test(s.userCode)
        ? Promise.race([
            helpers.copy(s.userCode).then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), COPY_TIMEOUT_MS);
              timer.unref();
            }),
          ])
        : Promise.resolve(false);
    void copied
      .catch(() => false)
      .then((ok) => {
        clearTimeout(timer);
        // openUrl opens only http(s) and is silent otherwise: say nothing about a browser then.
        const opens = openableUrl(s.verificationUri) !== undefined;
        const copiedLine = ok ? 'The code is copied to the clipboard' : undefined;
        if (!opens) {
          if (copiedLine) io.err(`${copiedLine}.`);
          return;
        }
        io.err(copiedLine ? `${copiedLine}; opening the browser…` : 'Opening the browser…');
        // openUrl restricts to http/https, so it gets the raw value; the sanitized form is for display.
        helpers.openUrl(s.verificationUri);
      })
      .catch(() => undefined);
  };
}

/**
 * The exit for a device login that ended without a login: 130 when cancelled (quietly), 1 when the
 * re-issued code lapsed too (nobody is at the browser, so a third code would only wait), naming
 * the command to run again. Undefined for any other error, which the caller reports its own way.
 */
export function deviceLoginEnd(
  io: Io,
  err: unknown,
  o: { prefix: string; again: string },
): number | undefined {
  if (err instanceof LoginCancelledError) return 130;
  if (err instanceof LoginExpiredError) {
    io.err(
      `${o.prefix}: the sign-in window expired before it was approved — run \`${o.again}\` again`,
    );
    return 1;
  }
  return undefined;
}

/**
 * `mocactl login --test-user N` (ADR-0045). The secret comes from MOCA_TEST_USER_SECRET in the
 * environment, never a flag: a flag would put it in the shell history and in every `ps` listing of
 * the machine running the test.
 */
export async function cmdLoginTestUser(
  rt: Runtime,
  io: Io,
  index: number,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp) return 2;
  const secret = env.MOCA_TEST_USER_SECRET ?? '';
  if (secret === '') {
    io.err(
      'login failed: --test-user needs the shared secret in MOCA_TEST_USER_SECRET ' +
        "(the control plane's SH_TEST_USER_SECRET)",
    );
    return 2;
  }
  try {
    const login = await rt.cp.testUserToken(index, secret);
    // The SAME store a device login writes, so renewal and every later command behave identically.
    setAuth(rt, toCachedAuth(login, rt.endpoints.controlPlaneUrl!));
    io.err(`logged in as ${login.displayName ?? login.subject} (${login.subject})`);
    return 0;
  } catch (err) {
    // The two misconfigurations worth naming, in the style identity.ts uses for the device flow:
    // say the fix, and name only settings.
    if (err instanceof ApiError && err.status === 404) {
      io.err(
        'login failed: this control plane has no test users ' +
          '(set SH_TEST_USERS on the control plane to enable them)',
      );
      return 1;
    }
    if (err instanceof ApiError && err.code === 'unauthorized') {
      io.err(
        'login failed: the test-user secret was refused ' +
          "(MOCA_TEST_USER_SECRET must match the control plane's SH_TEST_USER_SECRET)",
      );
      return 1;
    }
    io.err(`login failed: ${describeError(err)}`);
    return 1;
  }
}

export async function cmdLogin(
  rt: Runtime,
  io: Io,
  signal?: AbortSignal,
  helpers?: LoginHelpers,
): Promise<number> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp) return 2;
  try {
    const login = await deviceLogin(
      { cp: rt.cp, sleep: rt.sleep, now: rt.now },
      devicePrompt(io, helpers),
      signal,
    );
    setAuth(rt, toCachedAuth(login, rt.endpoints.controlPlaneUrl!));
    io.err(`logged in as ${login.displayName ?? login.subject}`);
    return 0;
  } catch (err) {
    const end = deviceLoginEnd(io, err, { prefix: 'login failed', again: 'mocactl login' });
    if (end !== undefined) return end;
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
    io.err('not logged in — run `mocactl login`' + mismatchClause(rt));
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
    storedLoginUrl: otherControlPlaneLogin(rt),
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
  /** Interleave the turn's tool calls with its text (#419). Redundant under `json`, which has them. */
  showTools?: boolean;
}

/**
 * One tool call is one line, so a newline inside a remote argument (a path, a pattern) cannot break
 * the layout up. Control characters are already gone -- this runs on sanitizeRemote's output, which
 * keeps `\n` deliberately for the text path.
 */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trimEnd();

/**
 * False (with the reason on stderr) unless there is a control plane and a valid login for it. The
 * harness is not asked about: `mocactl sbx` has a control plane of its own and no harness.
 */
export function readyCp(rt: Runtime, io: Io): rt is Runtime & Required<Pick<Runtime, 'cp'>> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp) return false;
  if (!apiTokenValid(rt.auth, rt.now())) {
    io.err(
      rt.auth?.refreshToken
        ? 'the login could not be refreshed — is the control plane reachable? (`mocactl doctor`)'
        : 'not logged in — run `mocactl login` first' + mismatchClause(rt),
    );
    return false;
  }
  return true;
}

/** `readyCp`, and a harness too. */
export function ready(
  rt: Runtime,
  io: Io,
): rt is Runtime & Required<Pick<Runtime, 'cp' | 'harness'>> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp || !rt.harness) return false;
  return readyCp(rt, io);
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

/**
 * `mocactl bundles list`: the caller's own stored config bundles (rossoctl/moca#559).
 *
 * The digest is printed in full, not abbreviated, because the only thing to do with a listed bundle
 * is `mocactl bundles delete <digest>` -- an elided digest would have to be retyped from the server.
 */
export async function cmdBundleList(rt: Runtime, io: Io, opts: ManageOptions): Promise<number> {
  if (!ready(rt, io)) return 2;
  let bundles: ConfigBundleSummary[];
  try {
    bundles = (await cancellable(rt.cp.listConfigBundles(), opts.signal)).bundles;
  } catch (err) {
    return failed(io, err);
  }
  if (opts.json) {
    io.out(JSON.stringify({ bundles }) + '\n');
    return 0;
  }
  if (bundles.length === 0) {
    // On stderr with no header, so `mocactl bundles list | wc -l` answers 0 for an empty listing.
    io.err('no config bundles');
    return 0;
  }
  const head = ['DIGEST', 'BYTES', 'PROMOTED (UTC)', 'EXPIRES (UTC)'];
  const body = bundles.map((b) =>
    [
      b.digest,
      // Stringified here so it passes through the same sanitizeRemote as every other cell: these are
      // remote values, and `bytes: number` is only what the type says.
      String(b.bytes),
      b.promotedAt === null ? '-' : utc(b.promotedAt),
      utc(b.expiresAt),
    ].map(sanitizeRemote),
  );
  io.out(table([head, ...body]) + '\n');
  return 0;
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

/** The most a headless turn waits on "no capacity" before it fails (SessionDeps.maxCapacityWaitMs). */
export const HEADLESS_CAPACITY_WAIT_MS = 15 * 60 * 1000;

export async function cmdRun(rt: Runtime, io: Io, opts: RunOptions): Promise<number> {
  if (!ready(rt, io)) return 2;
  const manager = new SessionManager({
    cp: rt.cp,
    harness: rt.harness,
    transcripts: rt.transcripts,
    now: rt.now,
    sleep: rt.sleep,
    maxCapacityWaitMs: HEADLESS_CAPACITY_WAIT_MS,
    onActivationWait: (s) => io.err(`the session's template is activating; retrying in ${s} s`),
  });

  // An explicit empty --session is a mistake (a script whose id lookup came back empty), not a
  // request for a new session: starting one silently ran the prompt in a fresh session with no
  // options.
  if (opts.session !== undefined && opts.session.trim() === '') {
    io.err('--session needs a session id (it was empty); leave it out to start a new session');
    return 2;
  }

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
        // '' is the model field's "deployment default" choice: named in words, not as a bare comma.
        const named = r.choices.filter((c) => c.value !== '');
        const declared =
          named.map((c) => sanitizeRemote(c.value)).join(', ') +
          (named.length < r.choices.length ? ' (or empty for the deployment default)' : '');
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
      // --show-tools (#419). Both go to STDOUT, interleaved with the text rather than beside it on
      // stderr: the point of the flag is to show, in order, what the agent did before it answered.
      // Fenced in newlines of their own, because the text they sit between arrives as deltas that
      // may end mid-line. `toolSummary` is the TUI's own formatter, so the two agree per tool.
      else if (opts.showTools && e.frame.type === 'tool_use')
        io.out(`\n${oneLine(sanitizeRemote(toolSummary(e.frame.name, e.frame.args)))}\n`);
      // Only a FAILED result is reported, and without its preview: a successful command's output is
      // the agent's business, and a preview is remote multi-line text that would bury the answer.
      else if (opts.showTools && e.frame.type === 'tool_result' && e.frame.isError)
        io.out('  (that command failed)\n');
    } else if (e.kind === 'retrying') {
      // The server's reason, when it gives one (a pool, tier or template; server-originated, so
      // sanitized), tells a wait that will end from one that will not.
      io.err(
        `the harness has no capacity — retrying in ${e.seconds}s` +
          (e.reason ? ` (${sanitizeRemote(e.reason)})` : ''),
      );
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

/** What the credential commands need ready: `mocactl sbx` has a control plane and no harness. */
export interface CredentialReadiness {
  readiness?: 'cp' | 'harness';
  /** The exit code for a failed request, when the caller words failures itself (default: `failed`). */
  onError?: (err: unknown) => number;
}

const credentialsReady = (
  rt: Runtime,
  io: Io,
  o: CredentialReadiness,
): rt is Runtime & Required<Pick<Runtime, 'cp'>> =>
  o.readiness === 'cp' ? readyCp(rt, io) : ready(rt, io);

export async function cmdSessions(rt: Runtime, io: Io, opts: ManageOptions): Promise<number> {
  if (!ready(rt, io)) return 2;
  let sessions: SessionSummary[];
  try {
    sessions = await cancellable(allSessions(rt), opts.signal);
  } catch (err) {
    return failed(io, err);
  }
  // Titles are local (renamed in the TUI, or the first prompt); the control plane keeps none.
  // `turns` is the server's own count of completed turns, left out when #406 added this command
  // because nothing wrote it then and it read 0 on every deployment (#420 gave it a writer).
  const rows = sessions.map((s) => ({
    sessionId: s.sessionId,
    title: rt.transcripts?.load(s.sessionId)?.title ?? null,
    state: s.state,
    createdAt: s.createdAt,
    lastTurnAt: s.lastTurnAt,
    turns: s.turns,
  }));
  if (opts.json) {
    io.out(JSON.stringify({ sessions: rows }) + '\n');
    return 0;
  }
  if (rows.length === 0) {
    io.err('no sessions');
    return 0;
  }
  const head = ['ID', 'STATE', 'TURNS', 'CREATED (UTC)', 'LAST TURN (UTC)', 'TITLE'];
  const body = rows.map((r) =>
    [
      r.sessionId,
      r.state,
      // Stringified here rather than left to `table`, so it passes through the same sanitizeRemote
      // as every other cell: this is a remote value, and `turns: number` is only what the type says.
      String(r.turns),
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

export async function cmdCredentials(
  rt: Runtime,
  io: Io,
  opts: ManageOptions & CredentialReadiness,
): Promise<number> {
  if (!credentialsReady(rt, io, opts)) return 2;
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
    return opts.onError ? opts.onError(err) : failed(io, err);
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

export interface CredentialAddOptions extends ManageOptions, CredentialReadiness {
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
  if (!credentialsReady(rt, io, opts)) return 2;
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
    return opts.onError ? opts.onError(err) : failed(io, err);
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
    return opts.onError ? opts.onError(err) : failed(io, err);
  }
  io.err(`stored credential ${sanitizeRemote(name)}`);
  if (opts.json) io.out(JSON.stringify({ name, status: 'stored' }) + '\n');
  return 0;
}

export async function cmdCredentialDelete(
  rt: Runtime,
  io: Io,
  opts: ManageOptions & CredentialReadiness & { name: string },
): Promise<number> {
  if (!credentialsReady(rt, io, opts)) return 2;
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
    return opts.onError ? opts.onError(err) : failed(io, err);
  }
  io.err(`deleted credential ${name}`);
  if (opts.json) io.out(JSON.stringify({ name: opts.name, status: 'deleted' }) + '\n');
  return 0;
}
