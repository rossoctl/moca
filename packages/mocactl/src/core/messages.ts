import { ApiError, classify } from '../api/errors.js';
import { sanitizeRemote } from './sanitize.js';

/**
 * The one sentence a user sees for an error, headless or in the TUI (spec §8.1). Error messages
 * carry server text, so the result is always terminal-safe.
 */
export function describeError(err: unknown): string {
  return sanitizeRemote(describe(err));
}

/**
 * A newer mocactl against a control plane that predates model switching (per-session model spec
 * §7): its router answers the catalog and PATCH routes with a bare 404 `not_found`. A 404
 * `session_not_found` is a real answer about the session, so it is not this.
 */
export const MODEL_SWITCH_UNSUPPORTED = 'this control plane does not support switching models';
export function isModelSwitchUnsupported(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code !== 'session_not_found';
}

/**
 * describeError for a login that failed (`mocactl login`, `mocactl sbx login`, the TUI's Login
 * overlay), which is the one place a user cannot tell what went wrong from the sentence alone
 * (#700): the control plane may be one they set long ago (a flag, MOCACTL_SBX_URL, config.json),
 * and "unavailable" is the same words for a maintenance window, a proxy's error page and a server
 * bug. So the sentence names the control plane it tried, and keeps the friendly advice but adds
 * what came back: the HTTP status and the API's error code and message, or the network error.
 */
export function describeLoginError(err: unknown, controlPlaneUrl: string): string {
  const cp = `the control plane at ${displayUrl(controlPlaneUrl)}`;
  if (!(err instanceof ApiError) || err.source !== 'control-plane') {
    // Not an API answer: a 200 that was not JSON (a proxy's page), a timeout, a lock. Its own
    // text, with where it came from.
    return sanitizeRemote(`${describe(err)} (from ${cp})`);
  }
  const text = describe(err, cp);
  if (err.status === 0) {
    // "cannot reach" already carries the network error, its cause code folded in (networkError);
    // a dropped connection's sentence does not.
    return sanitizeRemote(err.code === 'connection_dropped' ? `${text}: ${err.message}` : text);
  }
  const cause = httpCause(err, text);
  if (classify(err).kind === 'unavailable')
    return sanitizeRemote(`${cp} is unavailable (${cause}) — try again shortly`);
  // A body with no message of its own leaves the code as the "message" (ApiError's fallback), and
  // repeating it beside its cause reads `not_found (... HTTP 404 not_found)`: say what happened.
  if (err.message === err.code) return sanitizeRemote(`${cp} refused the login (${cause})`);
  // Most sentences name the control plane now; the server's own message ('show') does not.
  return sanitizeRemote(text.includes(cp) ? `${text} (${cause})` : `${text} (${cp}: ${cause})`);
}

/**
 * What came back, in a few words: `HTTP 503 redis_unavailable: the reason`. The message is left
 * out when the sentence already says it, and a body that was not the API's own JSON (a proxy's or
 * a firewall's page, code `http_<status>`) is named as that rather than as an error code.
 */
function httpCause(err: ApiError, said: string): string {
  if (err.code === `http_${err.status}`) return `HTTP ${err.status}, not an API answer: a proxy?`;
  const message = err.message && err.message !== err.code && !said.includes(err.message);
  return `HTTP ${err.status} ${err.code}${message ? `: ${err.message}` : ''}`;
}

/**
 * The control-plane URL as configured, but never its userinfo, query or fragment: a URL typed
 * with `user:password@` must not put the password on the screen.
 */
export function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

/** `cp`: how to name the control plane, "the control plane" unless a caller knows its URL. */
function describe(err: unknown, cp = 'the control plane'): string {
  if (err instanceof ApiError) {
    const peer = err.source === 'harness' ? 'the harness' : cp;
    // Reached, then cut: not "cannot reach". Raised for any request or stream body the peer closed,
    // so the text claims nothing about how far the exchange got.
    if (err.code === 'connection_dropped')
      return `${peer} closed the connection (a proxy idle timeout?)`;
    const action = classify(err);
    switch (action.kind) {
      case 'login':
        return 'your login has expired — run `mocactl login` (or restart mocactl) to log in again';
      case 'harness-token-rejected':
        return 'the harness rejected the session token — run `mocactl doctor`';
      case 'session-gone':
        return 'that session no longer exists, or is not yours';
      case 'bundle-expired':
        return "this session's config bundle is gone (expired or never uploaded) — promote the same directory again; if it changed, start a new session";
      case 'bundle-quota':
        return "the control plane's config-bundle storage is full for your account or the deployment — free yours with `mocactl bundles delete DIGEST`, or ask the operator";
      case 'endpoint-unresolved':
        return `the inference credential has no gateway endpoint (${action.message}) — edit it in /credentials`;
      case 'operator-misconfigured':
        return `${cp} cannot log anyone in until its operator fixes it — ${action.message}`;
      case 'retry-after':
        return `the harness has no capacity — retry in ${action.seconds}s`;
      case 'unavailable':
        return `${peer} is unavailable — try again shortly`;
      case 'connection':
        return `cannot reach ${peer}: ${action.message}`;
      case 'show':
        return action.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
