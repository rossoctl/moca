import { describe, expect, it } from 'vitest';
import {
  LoginCancelledError,
  LoginExpiredError,
  apiTokenValid,
  codeValidity,
  deviceLogin,
  loginExpiryMinutes,
  toCachedAuth,
} from '../src/core/auth.js';
import { sleep } from '../src/core/time.js';
import { fakeControlPlane } from './helpers/fakes.js';

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => void (t += ms),
    advance: (ms: number) => (t += ms),
  };
}

const login = {
  token: 'api',
  subject: 'github:1',
  displayName: 'Ada',
  roles: ['user'],
  expiresAt: 3600,
};

describe('deviceLogin', () => {
  it('shows the code, polls at the server interval, and returns the login', async () => {
    const c = clock();
    const polls: number[] = [];
    let n = 0;
    const cp = fakeControlPlane({
      pollDeviceAuth: async () => (polls.push(c.now()), ++n < 3 ? 'pending' : login),
    });
    const shown: string[] = [];
    const result = await deviceLogin({ cp, ...c }, (s) => shown.push(s.userCode));
    expect(result).toEqual(login);
    expect(shown).toEqual(['ABCD-1234']);
    expect(polls).toEqual([5000, 10000, 15000]);
  });

  /** A control plane that hands out codes U1, U2, ... each valid for `expiresIn` seconds. */
  function issuing(expiresIn: number, poll: (deviceCode: string) => Promise<unknown>) {
    let n = 0;
    const issued: string[] = [];
    const cp = fakeControlPlane({
      startDeviceAuth: async () => {
        n += 1;
        issued.push(`d${n}`);
        return {
          deviceCode: `d${n}`,
          userCode: `U${n}`,
          verificationUri: 'v',
          interval: 5,
          expiresIn,
        };
      },
      pollDeviceAuth: poll as never,
    });
    return { cp, issued };
  }

  it('re-issues the code once when the control plane says it expired, and logs in with the new one', async () => {
    // #431: a user away from the browser comes back to a fresh code, not a failed login.
    const c = clock();
    const polled: string[] = [];
    const { cp, issued } = issuing(900, async (dc) => {
      polled.push(dc);
      return dc === 'd1' ? 'expired' : login;
    });
    const shown: Array<[string, number]> = [];
    const result = await deviceLogin({ cp, ...c }, (s, attempt) =>
      shown.push([s.userCode, attempt]),
    );
    expect(result).toEqual(login);
    expect(issued).toEqual(['d1', 'd2']);
    expect(polled).toEqual(['d1', 'd2']);
    expect(shown).toEqual([
      ['U1', 1],
      ['U2', 2],
    ]);
  });

  it('re-issues once when the local deadline passes too, then gives up with LoginExpiredError', async () => {
    const c = clock();
    const { cp, issued } = issuing(12, async () => 'pending');
    const shown: string[] = [];
    await expect(deviceLogin({ cp, ...c }, (s) => shown.push(s.userCode))).rejects.toBeInstanceOf(
      LoginExpiredError,
    );
    expect(issued).toEqual(['d1', 'd2']);
    expect(shown).toEqual(['U1', 'U2']);
  });

  it('gives up with LoginExpiredError when the re-issued code expires as well, never a third code', async () => {
    const c = clock();
    const { cp, issued } = issuing(900, async () => 'expired');
    await expect(deviceLogin({ cp, ...c }, () => undefined)).rejects.toBeInstanceOf(
      LoginExpiredError,
    );
    expect(issued).toEqual(['d1', 'd2']);
  });

  it('stops with LoginCancelledError when aborted', async () => {
    const ac = new AbortController();
    const c = clock();
    const cp = fakeControlPlane();
    const p = deviceLogin(
      {
        cp,
        now: c.now,
        sleep: async (ms) => {
          c.advance(ms);
          ac.abort();
        },
      },
      () => undefined,
      ac.signal,
    );
    await expect(p).rejects.toBeInstanceOf(LoginCancelledError);
  });

  it('propagates a real error from the poll', async () => {
    const c = clock();
    const cp = fakeControlPlane({
      pollDeviceAuth: async () => {
        throw new Error('access_denied');
      },
    });
    await expect(deviceLogin({ cp, ...c }, () => undefined)).rejects.toThrow('access_denied');
  });
});

describe('codeValidity', () => {
  it('reads as whole minutes, rounded down so it never overstates, and seconds under one', () => {
    expect(codeValidity(900)).toBe('15 minutes');
    expect(codeValidity(899)).toBe('14 minutes');
    expect(codeValidity(60)).toBe('1 minute');
    expect(codeValidity(45)).toBe('45 seconds');
  });
});

describe('cached auth helpers', () => {
  const auth = toCachedAuth(login, 'http://cp');

  it('maps a login to the cache shape', () => {
    expect(auth).toEqual({
      apiToken: 'api',
      subject: 'github:1',
      displayName: 'Ada',
      roles: ['user'],
      expiresAt: 3600,
      controlPlaneUrl: 'http://cp',
    });
  });

  it('treats an expired or missing token as invalid', () => {
    expect(apiTokenValid(auth, 3_599_000)).toBe(true);
    expect(apiTokenValid(auth, 3_600_000)).toBe(false);
    expect(apiTokenValid(null, 0)).toBe(false);
  });

  it('warns only in the last five minutes', () => {
    expect(loginExpiryMinutes(auth, 3_000_000)).toBeUndefined();
    expect(loginExpiryMinutes(auth, 3_361_000)).toBe(4);
    expect(loginExpiryMinutes(auth, 3_600_000)).toBeUndefined();
  });

  it('does not warn when a refresh token will renew the login', () => {
    const renewing = { ...auth, refreshToken: 'mrt_x' };
    expect(loginExpiryMinutes(renewing, 3_361_000)).toBeUndefined();
  });
});

describe('toCachedAuth carries the refresh pair (B14)', () => {
  it('keeps refreshToken and refreshExpiresAt when the control plane sent them', () => {
    const a = toCachedAuth(
      { token: 't', subject: 's', expiresAt: 1, refreshToken: 'mrt_x', refreshExpiresAt: 2 },
      'http://cp',
    );
    expect(a).toMatchObject({ refreshToken: 'mrt_x', refreshExpiresAt: 2 });
  });

  it('omits them for a control plane that predates B14', () => {
    const a = toCachedAuth({ token: 't', subject: 's', expiresAt: 1 }, 'http://cp');
    expect(a).not.toHaveProperty('refreshToken');
    expect(a).not.toHaveProperty('refreshExpiresAt');
  });
});

describe('sleep', () => {
  it('resolves early when aborted', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await p;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
