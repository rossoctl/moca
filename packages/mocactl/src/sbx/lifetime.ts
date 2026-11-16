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

/** A lifetime in the largest unit that divides it exactly. */
export function lifetimeText(s: number): string {
  if (s % 86_400 === 0) return `${s / 86_400} d`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

/** `, after 7 d without use`, or nothing when the control plane did not say. */
export function afterText(s: { idleLifetimeS?: number }): string {
  return s.idleLifetimeS !== undefined
    ? `, after ${lifetimeText(s.idleLifetimeS)} without use`
    : '';
}
