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
 */
export const forLog = (value: string): string => value.replace(/[\r\n]+/g, ' ');
