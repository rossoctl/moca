import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CpError } from '../src/errors.js';
import {
  GithubOAuthProvider,
  MEMBER_SUBJECT_RE,
  SUBJECT_RE,
  TEST_SUBJECT_RE,
  TEST_USERS_MAX,
  TEST_USER_SECRET_MIN_CHARS,
  TestUserProvider,
  adminSubjectsFromEnv,
  rolesFor,
  secretMatches,
  shortClientId,
  testSubject,
  testUserSecretFromEnv,
  testUsersFromEnv,
  type FetchLike,
} from '../src/identity.js';

/** Records every request and replies from a scripted queue keyed by URL substring. */
function fakeFetch(script: Record<string, { status: number; body: unknown }[]>) {
  const seen: { url: string; method: string; headers: Record<string, string>; body?: string }[] =
    [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, ...init });
    const key = Object.keys(script).find((k) => url.includes(k));
    if (!key) throw new Error(`no scripted reply for ${url}`);
    const next = script[key]!.length > 1 ? script[key]!.shift()! : script[key]![0]!;
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { fetch, seen };
}

const provider = (fetch: FetchLike, adminSubjects: string[] = []) =>
  new GithubOAuthProvider({ clientId: 'Iv1.fakeclientid', adminSubjects, fetch }); // notsecret

const errOf = async (fn: () => Promise<unknown>): Promise<CpError> => {
  try {
    await fn();
  } catch (e) {
    return e as CpError;
  }
  throw new Error('expected a throw');
};

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => (await errOf(fn)).code;

describe('the constructor refuses a missing client id', () => {
  // main.ts already validates SH_GITHUB_CLIENT_ID, but this guard is the one that holds if a second
  // caller ever constructs the provider directly -- and '' must fail exactly as undefined does, since
  // control-plane.yaml ships the variable present-but-empty on purpose.
  it('throws naming the env var, for both unset and empty', () => {
    for (const clientId of [undefined, '']) {
      expect(
        () => new GithubOAuthProvider({ clientId: clientId as string }),
        String(clientId),
      ).toThrow(/SH_GITHUB_CLIENT_ID is required/);
    }
  });

  it('accepts a non-empty one', () => {
    expect(() => new GithubOAuthProvider({ clientId: 'Iv1.abc' })).not.toThrow();
  });
});

describe('startDeviceAuth', () => {
  it('returns what an operator has to type, and how fast to poll', () => {
    const { fetch } = fakeFetch({
      '/login/device/code': [
        {
          status: 200,
          body: {
            device_code: 'dc-1',
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          },
        },
      ],
    });
    return expect(provider(fetch).startDeviceAuth()).resolves.toEqual({
      deviceCode: 'dc-1',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });
  });

  it('asks for JSON, because GitHub otherwise replies form-encoded', async () => {
    const { fetch, seen } = fakeFetch({
      '/login/device/code': [
        { status: 200, body: { device_code: 'd', user_code: 'u', verification_uri: 'v' } },
      ],
    });
    await provider(fetch).startDeviceAuth();
    expect(seen[0]!.headers.Accept).toBe('application/json');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.body).toContain('client_id=Iv1.fakeclientid'); // notsecret
  });

  it('sends no client secret — the device flow treats the app as a public client', async () => {
    // Which is also why §5.1.1 is safe to run from a script a developer reads.
    const { fetch, seen } = fakeFetch({
      '/login/device/code': [
        { status: 200, body: { device_code: 'd', user_code: 'u', verification_uri: 'v' } },
      ],
    });
    await provider(fetch).startDeviceAuth();
    expect(seen[0]!.body).not.toContain('client_secret');
  });

  it('defaults a missing interval to 5 seconds rather than to 0', async () => {
    // interval: 0 would make a polling client hot-loop GitHub into a slow_down.
    const { fetch } = fakeFetch({
      '/login/device/code': [
        { status: 200, body: { device_code: 'd', user_code: 'u', verification_uri: 'v' } },
      ],
    });
    expect((await provider(fetch).startDeviceAuth()).interval).toBe(5);
  });

  it('surfaces any other GitHub error as unauthorized, not as a 500', async () => {
    const { fetch } = fakeFetch({
      '/login/device/code': [{ status: 400, body: { error: 'unsupported_grant_type' } }],
    });
    expect(await codeOf(() => provider(fetch).startDeviceAuth())).toBe('unauthorized');
  });

  describe('an OAuth app GitHub refuses (#405)', () => {
    // The control plane logs these too (the operator reads its log, not the user's terminal);
    // silence that here and assert on it where it matters.
    const logged = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    afterEach(() => vi.restoreAllMocks());

    it('reports a device-flow-disabled app as identity_provider_misconfigured, naming the fix', async () => {
      // Device flow is OFF by default on a GitHub OAuth app (spec §5.1.1): the likeliest first-run
      // failure, and one only the operator can fix -- so the message is the fix, not GitHub's code.
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { fetch } = fakeFetch({
        '/login/device/code': [
          {
            status: 400,
            body: { error: 'device_flow_disabled', error_description: 'not enabled' },
          },
        ],
      });
      const p = provider(fetch).startDeviceAuth();
      await expect(p).rejects.toMatchObject({ code: 'identity_provider_misconfigured' });
      await expect(p).rejects.toThrow(/Enable Device Flow/);
      await expect(p).rejects.toThrow(/device_flow_disabled/);
      expect(logged().join('\n')).toMatch(/device_flow_disabled/);
    });

    it('reports a mistyped client id (GitHub 404) without echoing the whole id', async () => {
      // GitHub's reply never mentions the client id, so the message must, or the 404 is
      // undiagnosable. But only part of it: a wrong value may be a pasted secret, and this reply
      // reaches an unauthenticated caller. The log gets the same shortened form.
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { fetch } = fakeFetch({
        '/login/device/code': [{ status: 404, body: { error: 'Not Found' } }],
      });
      const err = await errOf(() => provider(fetch).startDeviceAuth());
      expect(err).toMatchObject({ code: 'identity_provider_misconfigured' });
      expect(err.message).toMatch(/SH_GITHUB_CLIENT_ID/);
      expect(err.message).toMatch(/\(Not Found\)/);
      expect(err.message).toContain('Iv1.fa… (16 chars)');
      expect(err.message).not.toContain('Iv1.fakeclientid');
      expect(logged().join('\n')).not.toContain('Iv1.fakeclientid');
    });

    it("keys the unknown-client case on the 404, not on GitHub's wording", async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { fetch } = fakeFetch({
        '/login/device/code': [{ status: 404, body: { error: 'no_such_application' } }],
      });
      const err = await errOf(() => provider(fetch).startDeviceAuth());
      expect(err).toMatchObject({ code: 'identity_provider_misconfigured' });
      // GitHub's own text is interpolated, so a log grep for it still works when it changes.
      expect(err.message).toMatch(/\(no_such_application\)/);
    });
  });
});

describe('shortClientId', () => {
  it('shows at most six characters, and never more than half the value', () => {
    expect(shortClientId('Ov23liAbCdEfGhIjKlMn')).toBe('Ov23li… (20 chars)');
    expect(shortClientId('abcd')).toBe('ab… (4 chars)');
    expect(shortClientId('a')).toBe('… (1 char)');
  });
});

describe('completeDeviceAuth', () => {
  const authorized = {
    '/login/oauth/access_token': [{ status: 200, body: { access_token: 'gho-fake' } }], // notsecret
    '/user': [{ status: 200, body: { id: 1234, login: 'alice', name: 'Alice Example' } }],
  };

  it('derives the subject from the NUMERIC id, never the login', async () => {
    // The login is mutable and reusable after account deletion, so a login-keyed subject would let a
    // new account inherit a departed user's sessions and credentials (spec §5.1).
    const { fetch } = fakeFetch(authorized);
    expect(await provider(fetch).completeDeviceAuth('dc-1')).toEqual({
      subject: 'github:1234',
      displayName: 'Alice Example',
      roles: [],
    });
  });

  it('falls back to the login for the display name only', async () => {
    const { fetch } = fakeFetch({
      ...authorized,
      '/user': [{ status: 200, body: { id: 1234, login: 'alice', name: null } }],
    });
    const p = await provider(fetch).completeDeviceAuth('dc-1');
    expect(p.displayName).toBe('alice');
    expect(p.subject).toBe('github:1234');
  });

  it('stamps admin roles from the configured subject list', async () => {
    const { fetch } = fakeFetch(authorized);
    expect((await provider(fetch, ['github:1234']).completeDeviceAuth('dc-1')).roles).toEqual([
      'admin',
    ]);
    const { fetch: f2 } = fakeFetch(authorized);
    expect((await provider(f2, ['github:9999']).completeDeviceAuth('dc-1')).roles).toEqual([]);
  });

  it('never returns the GitHub access token', async () => {
    // MU1 stores no GitHub token at all: OAuth authenticates API CALLS, the stored credential
    // authorizes EGRESS, and the two are decoupled (spec §5.5) -- so no refresh token is needed and
    // the opaque token is used once, for GET /user, then dropped.
    const { fetch } = fakeFetch(authorized);
    const p = await provider(fetch).completeDeviceAuth('dc-1');
    expect(JSON.stringify(p)).not.toContain('gho-fake'); // notsecret
  });

  it('sends the access token as a Bearer to GET /user and nowhere else', async () => {
    const { fetch, seen } = fakeFetch(authorized);
    await provider(fetch).completeDeviceAuth('dc-1');
    const userCall = seen.find((c) => c.url.includes('/user'))!;
    expect(userCall.headers.Authorization).toBe('Bearer gho-fake'); // notsecret
    expect(seen.filter((c) => c.headers.Authorization).length).toBe(1);
  });

  it('maps authorization_pending to the pollable code, not to an error', async () => {
    const { fetch } = fakeFetch({
      '/login/oauth/access_token': [{ status: 200, body: { error: 'authorization_pending' } }],
    });
    expect(await codeOf(() => provider(fetch).completeDeviceAuth('dc-1'))).toBe(
      'authorization_pending',
    );
  });

  it('maps slow_down to the same pollable code', async () => {
    // A client that treated slow_down as fatal would abort a login that is still perfectly live.
    const { fetch } = fakeFetch({
      '/login/oauth/access_token': [{ status: 200, body: { error: 'slow_down', interval: 10 } }],
    });
    expect(await codeOf(() => provider(fetch).completeDeviceAuth('dc-1'))).toBe(
      'authorization_pending',
    );
  });

  it('maps expired_token to its own code, so a client can re-issue without reading the text', async () => {
    // A user away from the browser is the common way a login ends (#431): the client offers a new
    // code for this one, and must not string-match GitHub's error to tell it from a denial.
    const { fetch } = fakeFetch({
      '/login/oauth/access_token': [{ status: 200, body: { error: 'expired_token' } }],
    });
    expect(await codeOf(() => provider(fetch).completeDeviceAuth('dc-1'))).toBe(
      'device_code_expired',
    );
  });

  it('maps a terminal GitHub error to unauthorized', async () => {
    for (const error of ['access_denied', 'incorrect_device_code']) {
      const { fetch } = fakeFetch({
        '/login/oauth/access_token': [{ status: 200, body: { error } }],
      });
      expect(await codeOf(() => provider(fetch).completeDeviceAuth('dc-1')), error).toBe(
        'unauthorized',
      );
    }
  });

  it('rejects a /user reply with no numeric id rather than inventing a subject', async () => {
    const { fetch } = fakeFetch({
      ...authorized,
      '/user': [{ status: 200, body: { login: 'alice' } }],
    });
    expect(await codeOf(() => provider(fetch).completeDeviceAuth('dc-1'))).toBe('unauthorized');
  });

  it('rejects a non-JSON reply rather than throwing a raw SyntaxError', async () => {
    const fetch: FetchLike = async () => ({ status: 200, text: async () => '<html>502</html>' });
    expect(await codeOf(() => provider(fetch).completeDeviceAuth('dc-1'))).toBe('unauthorized');
  });

  it('rejects a JSON null reply rather than attempting to read its id', async () => {
    // typeof null === 'object', so the guard must check `parsed === null` explicitly.
    // This test pins that the `|| parsed === null` clause works (spec §5.5).
    const { fetch } = fakeFetch({
      '/login/oauth/access_token': [{ status: 200, body: { access_token: 'gho-fake' } }], // notsecret
      '/user': [{ status: 200, body: null }],
    });
    expect(await codeOf(() => provider(fetch).completeDeviceAuth('dc-1'))).toBe('unauthorized');
  });
});

describe('admin subjects', () => {
  it('parses a comma-separated list, ignoring blanks and whitespace', () => {
    expect(adminSubjectsFromEnv(' github:1 , github:2 ,, ')).toEqual(['github:1', 'github:2']);
  });

  it('is empty by default, so no deployment has an admin unless one is named', () => {
    expect(adminSubjectsFromEnv(undefined)).toEqual([]);
    expect(adminSubjectsFromEnv('')).toEqual([]);
    expect(rolesFor('github:1', [])).toEqual([]);
  });

  it('grants admin only on an exact subject match', () => {
    expect(rolesFor('github:1', ['github:1'])).toEqual(['admin']);
    expect(rolesFor('github:12', ['github:1'])).toEqual([]);
  });
});

describe('GithubOAuthProvider.rolesFor', () => {
  it('answers from the CURRENT admin list, so a refresh sees a removal', () => {
    const p = new GithubOAuthProvider({ clientId: 'Iv1.x', adminSubjects: ['github:1'] });
    expect(p.rolesFor('github:1')).toEqual(['admin']);
    expect(p.rolesFor('github:2')).toEqual([]);
  });
});

// ---------------------------------------------------------------- test users (ADR-0045)

describe('testUsersFromEnv', () => {
  it('is 0 when unset or empty, so the feature is off by default', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(testUsersFromEnv(raw), String(raw)).toBe(0);
    }
  });

  it('accepts a whole number', () => {
    expect(testUsersFromEnv('10')).toBe(10);
    expect(testUsersFromEnv(' 3 ')).toBe(3);
    expect(testUsersFromEnv('0')).toBe(0);
  });

  // Refused rather than coerced: a silent 0 from `SH_TEST_USERS=ten` would read as "the feature is
  // off" to an operator who had just switched it on.
  it('refuses junk rather than coercing it to 0', () => {
    for (const raw of ['ten', '1.5', '-1', '1e3', '0x10', '1,2']) {
      expect(() => testUsersFromEnv(raw), raw).toThrow(/SH_TEST_USERS/);
    }
  });

  it('refuses more than the cap, so a typo cannot mint a huge subject space', () => {
    expect(testUsersFromEnv(String(TEST_USERS_MAX))).toBe(TEST_USERS_MAX);
    expect(() => testUsersFromEnv(String(TEST_USERS_MAX + 1))).toThrow(/at most/);
    expect(() => testUsersFromEnv('100000')).toThrow(/at most/);
  });
});

describe('testUserSecretFromEnv', () => {
  const good = 'a'.repeat(TEST_USER_SECRET_MIN_CHARS); // notsecret

  it('requires a secret whenever test users are on', () => {
    // The whole point of the gate: the endpoint issues a real login for an arbitrary subject.
    expect(() => testUserSecretFromEnv(undefined, 10)).toThrow(/SH_TEST_USER_SECRET is required/);
    expect(() => testUserSecretFromEnv('', 10)).toThrow(/SH_TEST_USER_SECRET is required/);
  });

  it('refuses a short secret', () => {
    expect(() => testUserSecretFromEnv('short', 10)).toThrow(/at least/);
    expect(testUserSecretFromEnv(good, 10)).toBe(good);
  });

  it('refuses a secret with no test users: the operator thinks they enabled something', () => {
    expect(() => testUserSecretFromEnv(good, 0)).toThrow(/SH_TEST_USERS is not/);
  });

  it('is empty when neither is set', () => {
    expect(testUserSecretFromEnv(undefined, 0)).toBe('');
  });
});

describe('secretMatches', () => {
  const s = 'correct-horse-battery-staple'; // notsecret

  it('matches only the exact secret', () => {
    expect(secretMatches(s, s)).toBe(true);
    expect(secretMatches(s + 'x', s)).toBe(false);
    expect(secretMatches(s.slice(0, -1), s)).toBe(false);
    expect(secretMatches('', s)).toBe(false);
  });

  // A length mismatch must not throw (timingSafeEqual does on unequal buffers) nor short-circuit:
  // both sides are hashed to 32 bytes first, so the comparison is always over the same width.
  it('handles any length without throwing', () => {
    for (const presented of ['', 'x', 'y'.repeat(10_000)]) {
      expect(() => secretMatches(presented, s)).not.toThrow();
      expect(secretMatches(presented, s)).toBe(false);
    }
  });

  it('never matches when no secret is configured', () => {
    expect(secretMatches('', '')).toBe(false);
    expect(secretMatches('anything', '')).toBe(false);
  });
});

describe('TestUserProvider', () => {
  const secret = 'a'.repeat(TEST_USER_SECRET_MIN_CHARS); // notsecret
  const p = (count = 10, adminSubjects: string[] = []) =>
    new TestUserProvider({ count, secret, adminSubjects });

  it('refuses a non-positive count or a short secret', () => {
    expect(() => new TestUserProvider({ count: 0, secret })).toThrow(/positive/);
    expect(() => new TestUserProvider({ count: 1.5, secret })).toThrow(/positive/);
    expect(() => new TestUserProvider({ count: 1, secret: 'tiny' })).toThrow(/at least/);
  });

  it('mints test:<index> subjects with a readable display name', () => {
    expect(p().principalFor(1)).toEqual({
      subject: 'test:1',
      displayName: 'Test User 1',
      roles: [],
    });
    expect(p().principalFor(10).subject).toBe('test:10');
    expect(TEST_SUBJECT_RE.test(p().principalFor(7).subject)).toBe(true);
    expect(testSubject(3)).toBe('test:3');
  });

  it('bounds the index to 1..count', () => {
    const provider = p(10);
    expect(provider.has(1)).toBe(true);
    expect(provider.has(10)).toBe(true);
    for (const bad of [0, -1, 11, 1.5, Number.NaN]) {
      expect(provider.has(bad), String(bad)).toBe(false);
    }
    expect(() => provider.principalFor(11)).toThrow(/1\.\.10/);
  });

  // A test user is configured like a GitHub user, roles included.
  it('gives a test subject admin when SH_ADMIN_SUBJECTS names it', () => {
    expect(p(10, ['test:2']).principalFor(2).roles).toEqual(['admin']);
    expect(p(10, ['test:2']).principalFor(1).roles).toEqual([]);
    expect(p(10, ['test:2']).rolesFor('test:2')).toEqual(['admin']);
  });

  it('authenticates only the configured secret', () => {
    expect(p().authenticates(secret)).toBe(true);
    expect(p().authenticates('wrong')).toBe(false);
    expect(p().authenticates('')).toBe(false);
  });

  it('refuses the device flow: a test user has no browser', async () => {
    expect(await codeOf(() => p().startDeviceAuth())).toBe('unauthorized');
    expect(await codeOf(() => p().completeDeviceAuth())).toBe('unauthorized');
  });
});

describe('MEMBER_SUBJECT_RE', () => {
  it("takes a person's subject from either provider, and never a test user's", () => {
    for (const ok of ['github:1234', 'oidc:erin@example.test', 'oidc:0a1b2c3d-uuid'])
      expect(MEMBER_SUBJECT_RE.test(ok), ok).toBe(true);
    for (const bad of ['test:1', 'github:', 'github:abc', 'oidc:', 'oidc:a b', 'oidc:a:b', 'bob'])
      expect(MEMBER_SUBJECT_RE.test(bad), bad).toBe(false);
  });

  it('is SUBJECT_RE without test:<n>', () => {
    for (const s of ['github:7', 'oidc:x.y', 'test:3', 'oidc:-x'])
      expect(MEMBER_SUBJECT_RE.test(s), s).toBe(SUBJECT_RE.test(s) && !s.startsWith('test:'));
  });
});
