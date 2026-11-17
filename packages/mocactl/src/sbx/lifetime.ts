/**
 * Idle lifetimes (#770): `--lifetime DURATION` in, `N d` / `N h` / `N min` / `N s` out. The
 * client checks syntax only; the control plane's 400 names the range.
 */

const UNIT_S = { m: 60, h: 3600, d: 86_400 } as const;

/** `<n>m`, `<n>h`, `<n>d` or whole seconds, as seconds; undefined when malformed. */
export function parseLifetime(raw: string): number | undefined {
  const m = /^([1-9][0-9]*)([mhd])?$/.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]) * (m[2] ? UNIT_S[m[2] as keyof typeof UNIT_S] : 1);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** A lifetime the control plane answered that is fit to print: a positive whole number of seconds. */
export const validLifetime = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) > 0;

/** A lifetime in the largest unit that divides it exactly. */
export function lifetimeText(s: number): string {
  if (s % 86_400 === 0) return `${s / 86_400} d`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

/** `, after 7 d without use`, or nothing when the control plane did not say. */
export function afterText(s: { idleLifetimeS?: number }): string {
  return validLifetime(s.idleLifetimeS)
    ? `, after ${lifetimeText(s.idleLifetimeS)} without use`
    : '';
}

/**
 * The line for a `--lifetime` the control plane did not take (it answered another lifetime, or
 * none: a control plane from before idle lifetimes), or undefined when it did.
 */
export function lifetimeNotTakenText(
  id: string,
  asked: number | undefined,
  s: { idleLifetimeS?: number },
): string | undefined {
  if (asked === undefined || s.idleLifetimeS === asked) return undefined;
  const ends = validLifetime(s.idleLifetimeS)
    ? lifetimeText(s.idleLifetimeS)
    : "the deployment's default lifetime";
  return `sbx: ${id} ends after ${ends} without use: the control plane did not take --lifetime`;
}
