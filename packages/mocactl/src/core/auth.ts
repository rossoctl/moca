import type { ApiLogin, ControlPlaneApi, DeviceStart } from '../api/types.js';
import type { CachedAuth } from '../config.js';

export class LoginCancelledError extends Error {
  constructor() {
    super('login cancelled');
    this.name = 'LoginCancelledError';
  }
}

export class LoginExpiredError extends Error {
  constructor() {
    super('the login code expired before it was approved — start again');
    this.name = 'LoginExpiredError';
  }
}

export interface LoginDeps {
  cp: Pick<ControlPlaneApi, 'startDeviceAuth' | 'pollDeviceAuth'>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}

/** How many device codes one login may show: the first, and one re-issue after it expires. */
const MAX_CODES = 2;

/**
 * Run the device flow. `onCode` gets each code to show, with `attempt` 1 for the first.
 *
 * A code that expires unapproved -- the control plane says `device_code_expired`, or its
 * `expiresIn` passes here first -- is re-issued ONCE (#431). The usual way a login ends is a user
 * who was away from the browser, and a fresh code on the screen they come back to costs one
 * request where a failure costs a re-run. Once, not forever: an unattended login still ends, after
 * two codes' lifetimes, with LoginExpiredError.
 */
export async function deviceLogin(
  deps: LoginDeps,
  onCode: (start: DeviceStart, attempt: number) => void,
  signal?: AbortSignal,
): Promise<ApiLogin> {
  for (let attempt = 1; ; attempt++) {
    const start = await deps.cp.startDeviceAuth();
    onCode(start, attempt);
    const result = await pollOneCode(deps, start, signal);
    if (result !== 'expired') return result;
    if (attempt >= MAX_CODES) throw new LoginExpiredError();
  }
}

async function pollOneCode(
  deps: LoginDeps,
  start: DeviceStart,
  signal?: AbortSignal,
): Promise<ApiLogin | 'expired'> {
  const deadline = deps.now() + start.expiresIn * 1000;
  const interval = Math.max(1, start.interval) * 1000;
  for (;;) {
    await deps.sleep(interval, signal);
    if (signal?.aborted) throw new LoginCancelledError();
    if (deps.now() > deadline) return 'expired';
    const result = await deps.cp.pollDeviceAuth(start.deviceCode);
    if (result !== 'pending') return result;
  }
}

/** A code's lifetime for a person to read: whole minutes, rounded down; seconds under one. */
export function codeValidity(expiresInS: number): string {
  if (expiresInS < 60) return `${Math.max(0, Math.floor(expiresInS))} seconds`;
  const m = Math.floor(expiresInS / 60);
  return m === 1 ? '1 minute' : `${m} minutes`;
}

export function toCachedAuth(login: ApiLogin, controlPlaneUrl: string): CachedAuth {
  return {
    apiToken: login.token,
    subject: login.subject,
    displayName: login.displayName,
    roles: login.roles ?? [],
    expiresAt: login.expiresAt,
    controlPlaneUrl,
    ...(login.refreshToken ? { refreshToken: login.refreshToken } : {}),
    ...(login.refreshExpiresAt !== undefined ? { refreshExpiresAt: login.refreshExpiresAt } : {}),
  };
}

export function apiTokenValid(auth: CachedAuth | null, nowMs: number): boolean {
  return !!auth && auth.expiresAt * 1000 > nowMs;
}

export function loginExpiryMinutes(auth: CachedAuth | null, nowMs: number): number | undefined {
  // With a refresh token the next 401 renews the API token by itself; only a login without one expires.
  if (!auth || auth.refreshToken) return undefined;
  const leftMs = auth.expiresAt * 1000 - nowMs;
  if (leftMs <= 0 || leftMs >= 5 * 60_000) return undefined;
  return Math.ceil(leftMs / 60_000);
}
