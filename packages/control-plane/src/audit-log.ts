// Stdout mirror for audit decisions. Shape matches the supervisor's opts.log for easy future
// consolidation; call sites compose lines from the identifiers-only field whitelist.

export type AuditLog = (line: Record<string, unknown>) => void;

export const defaultAuditLog: AuditLog = (line) => console.log(JSON.stringify(line));

/**
 * A value that came from OUTSIDE, made safe to interpolate into a plain-text log line: CR and LF
 * stripped, so it cannot forge a second line and fake an operator-facing entry (log injection).
 *
 * `JSON.stringify` already does this for `defaultAuditLog`; the console.warn/console.error lines
 * operators actually read are plain text and do not. A credential name reaching such a line comes
 * from a request body or a grant claim, so it is the caller's string, not ours.
 *
 * `/\n|\r/g` verbatim, not a `[\r\n]+` class: this exact form is the one CodeQL's js/log-injection
 * recognises as a sanitiser, and a helper it cannot see through leaves the alert open on every call
 * site (#822). Same behaviour, and the scanner stays useful.
 */
export const forLog = (value: string): string => value.replace(/\n|\r/g, '');
