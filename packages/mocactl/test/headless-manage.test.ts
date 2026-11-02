import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import type { PutCredentialRequest, SessionSummary } from '../src/api/types.js';
import {
  cmdBundleDelete,
  cmdCredentialAdd,
  cmdCredentialDelete,
  cmdCredentials,
  cmdSessionDelete,
  cmdSessions,
  type CredentialAddOptions,
  type Io,
} from '../src/headless.js';
import { credential, fakeControlPlane } from './helpers/fakes.js';
import { testRuntime } from './helpers/runtime.js';

function io(): Io & { stdout: string; stderr: string[] } {
  const o = {
    stdout: '',
    stderr: [] as string[],
    out: (s: string) => void (o.stdout += s),
    err: (s: string) => void o.stderr.push(s),
  };
  return o;
}

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    owner: 'github:1',
    tenant: 't',
    createdAt: Date.UTC(2026, 8, 30, 9, 15),
    state: 'active',
    lastTurnAt: Date.UTC(2026, 8, 30, 9, 20),
    turns: 2,
    ...over,
  };
}

const loggedOut = { auth: null };

describe('cmdSessions', () => {
  it('follows every page and prints a table with local titles', async () => {
    const listSessions = vi.fn(async (opts?: { cursor?: number }) =>
      opts?.cursor === undefined
        ? { sessions: [summary('s-1')], nextCursor: 7 }
        : {
            sessions: [summary('s-2', { lastTurnAt: null, state: 'deleting', turns: 0 })],
            nextCursor: null,
          },
    );
    const rt = testRuntime({ cp: fakeControlPlane({ listSessions }) });
    rt.transcripts!.rename('s-1', 'fix \u001b]52;c;aGk=\u0007the build');
    const o = io();
    expect(await cmdSessions(rt, o, { json: false })).toBe(0);
    expect(listSessions.mock.calls.map((c) => c[0]?.cursor)).toEqual([undefined, 7]);
    const lines = o.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^ID\s+STATE\s+TURNS\s+CREATED \(UTC\)\s+LAST TURN \(UTC\)\s+TITLE$/);
    expect(lines[1]).toMatch(
      /^s-1\s+active\s+2\s+2026-09-30 09:15\s+2026-09-30 09:20\s+fix the build$/,
    );
    // A session that has run no turn reads 0, not a blank: the count is always known (#420).
    expect(lines[2]).toMatch(/^s-2\s+deleting\s+0\s+2026-09-30 09:15\s+-$/);
  });

  it('prints the documented --json shape', async () => {
    const rt = testRuntime({
      cp: fakeControlPlane({
        listSessions: async () => ({
          sessions: [summary('s-1'), summary('s-2')],
          nextCursor: null,
        }),
      }),
    });
    rt.transcripts!.rename('s-1', 'fix the build');
    const o = io();
    expect(await cmdSessions(rt, o, { json: true })).toBe(0);
    expect(JSON.parse(o.stdout)).toEqual({
      sessions: [
        {
          sessionId: 's-1',
          title: 'fix the build',
          state: 'active',
          createdAt: Date.UTC(2026, 8, 30, 9, 15),
          lastTurnAt: Date.UTC(2026, 8, 30, 9, 20),
          turns: 2,
        },
        {
          sessionId: 's-2',
          title: null,
          state: 'active',
          createdAt: Date.UTC(2026, 8, 30, 9, 15),
          lastTurnAt: Date.UTC(2026, 8, 30, 9, 20),
          turns: 2,
        },
      ],
    });
    expect(o.stdout.endsWith('\n')).toBe(true);
  });

  it("reports the SERVER's turn count, not the local transcript's (#420)", async () => {
    // The field was left out of this command when #406 added it, because nothing wrote it and it
    // read 0 everywhere; #420 gave it a writer. It must come from the summary: the local transcript
    // store is the one thing that is NOT authoritative here -- a headless run writes no transcript,
    // and a session resumed on another machine has none at all, yet both have run turns.
    const rt = testRuntime({
      cp: fakeControlPlane({
        listSessions: async () => ({ sessions: [summary('s-1', { turns: 7 })], nextCursor: null }),
      }),
    });
    expect(rt.transcripts!.load('s-1')).toBeNull();
    const o = io();
    expect(await cmdSessions(rt, o, { json: true })).toBe(0);
    expect((JSON.parse(o.stdout) as { sessions: { turns: number }[] }).sessions[0]!.turns).toBe(7);
    const t = io();
    expect(await cmdSessions(rt, t, { json: false })).toBe(0);
    expect(t.stdout.trimEnd().split('\n')[1]).toMatch(/^s-1\s+active\s+7\s/);
  });

  it('keeps stdout empty with no sessions, and prints an empty list with --json', async () => {
    const o = io();
    expect(await cmdSessions(testRuntime(), o, { json: false })).toBe(0);
    expect(o.stdout).toBe('');
    expect(o.stderr).toContain('no sessions');
    const j = io();
    expect(await cmdSessions(testRuntime(), j, { json: true })).toBe(0);
    expect(JSON.parse(j.stdout)).toEqual({ sessions: [] });
  });

  it('stops with an error when the control plane repeats a cursor', async () => {
    const rt = testRuntime({
      cp: fakeControlPlane({
        listSessions: async () => ({ sessions: [summary('s-1')], nextCursor: 3 }),
      }),
    });
    const o = io();
    expect(await cmdSessions(rt, o, { json: false })).toBe(1);
    expect(o.stdout).toBe('');
    expect(o.stderr.join('\n')).toContain('repeated');
  });

  it('exits 2 when not logged in, and 1 with a readable message when the request fails', async () => {
    const o = io();
    expect(await cmdSessions(testRuntime(loggedOut), o, { json: false })).toBe(2);
    expect(o.stderr).toContain('not logged in — run `mocactl login` first');
    const f = io();
    const rt = testRuntime({
      cp: fakeControlPlane({
        listSessions: async () => {
          throw new ApiError('control-plane', 401, 'token_expired');
        },
      }),
    });
    expect(await cmdSessions(rt, f, { json: false })).toBe(1);
    expect(f.stderr.join('\n')).toContain('mocactl login');
  });
});

describe('cmdSessionDelete', () => {
  it('deletes the session and its local history', async () => {
    const rt = testRuntime();
    rt.transcripts!.rename('s-1', 'old');
    const o = io();
    expect(await cmdSessionDelete(rt, o, { id: 's-1', json: false })).toBe(0);
    expect((rt.cp as ReturnType<typeof fakeControlPlane>).calls).toContain('deleteSession');
    expect(rt.transcripts!.has('s-1')).toBe(false);
    expect(o.stderr).toContain('deleted session s-1');
    expect(o.stdout).toBe('');
  });

  it('says when the deletion finishes in the background, and prints JSON', async () => {
    const rt = testRuntime({ cp: fakeControlPlane({ deleteSession: async () => 'accepted' }) });
    const o = io();
    expect(await cmdSessionDelete(rt, o, { id: 's-1', json: true })).toBe(0);
    expect(JSON.parse(o.stdout)).toEqual({ sessionId: 's-1', status: 'accepted' });
    expect(o.stderr.join('\n')).toContain('finishes in the background');
  });

  it('exits 1 when the session is not there, and drops its orphaned local history', async () => {
    const rt = testRuntime({
      cp: fakeControlPlane({
        deleteSession: async () => {
          throw new ApiError('control-plane', 404, 'session_not_found');
        },
      }),
    });
    rt.transcripts!.rename('s-x', 'old');
    const o = io();
    expect(await cmdSessionDelete(rt, o, { id: 's-x', json: false })).toBe(1);
    expect(o.stderr.join('\n')).toContain('no longer exists');
    expect(rt.transcripts!.has('s-x')).toBe(false);
  });

  it('keeps the local history when the delete fails for another reason', async () => {
    const rt = testRuntime({
      cp: fakeControlPlane({
        deleteSession: async () => {
          throw new ApiError('control-plane', 503, 'unavailable');
        },
      }),
    });
    rt.transcripts!.rename('s-1', 'old');
    expect(await cmdSessionDelete(rt, io(), { id: 's-1', json: false })).toBe(1);
    expect(rt.transcripts!.has('s-1')).toBe(true);
  });
});

describe('cmdCredentials', () => {
  const creds = [
    credential('anthropic', {
      kind: 'api-key',
      destination: { hosts: ['api.anthropic.com'] },
      endpoint: 'https://api.anthropic.com',
    }),
    credential('gh\u001b[8m', {
      consumer: 'sandbox-egress',
      destination: { hosts: ['github.com', 'api.github.com'] },
      endpoint: null,
    }),
  ];

  it('prints a terminal-safe table', async () => {
    const rt = testRuntime({ cp: fakeControlPlane({ listCredentials: async () => creds }) });
    const o = io();
    expect(await cmdCredentials(rt, o, { json: false })).toBe(0);
    const lines = o.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^NAME\s+KIND\s+CONSUMER\s+HOSTS\s+ENDPOINT$/);
    expect(lines[1]).toMatch(
      /^anthropic\s+api-key\s+inference\s+api\.anthropic\.com\s+https:\/\/api\.anthropic\.com$/,
    );
    expect(lines[2]).toMatch(/^gh\s+bearer\s+sandbox-egress\s+github\.com,api\.github\.com\s+-$/);
    expect(o.stdout).not.toContain('\u001b');
  });

  it('prints the documented --json shape', async () => {
    const rt = testRuntime({ cp: fakeControlPlane({ listCredentials: async () => creds }) });
    const o = io();
    expect(await cmdCredentials(rt, o, { json: true })).toBe(0);
    expect(JSON.parse(o.stdout)).toEqual({
      credentials: [
        {
          name: 'anthropic',
          kind: 'api-key',
          consumer: 'inference',
          hosts: ['api.anthropic.com'],
          endpoint: 'https://api.anthropic.com',
        },
        {
          name: 'gh\u001b[8m',
          kind: 'bearer',
          consumer: 'sandbox-egress',
          hosts: ['github.com', 'api.github.com'],
          endpoint: null,
        },
      ],
    });
  });

  it('keeps stdout empty with no credentials', async () => {
    const rt = testRuntime({ cp: fakeControlPlane({ listCredentials: async () => [] }) });
    const o = io();
    expect(await cmdCredentials(rt, o, { json: false })).toBe(0);
    expect(o.stdout).toBe('');
    expect(o.stderr).toContain('no credentials');
  });
});

describe('cmdCredentialAdd', () => {
  function adding(over: Partial<CredentialAddOptions> = {}): CredentialAddOptions {
    return {
      name: 'anthropic',
      kind: 'api-key',
      consumer: 'inference',
      hosts: ['api.anthropic.com'],
      endpoint: 'https://api.anthropic.com',
      json: false,
      stdinIsTTY: false,
      readStdin: async () => 'sk-ant-api03-secret\n',
      ...over,
    };
  }

  function recording() {
    const puts: Array<{ name: string; req: PutCredentialRequest }> = [];
    const rt = testRuntime({
      cp: fakeControlPlane({ putCredential: async (name, req) => void puts.push({ name, req }) }),
    });
    return { rt, puts };
  }

  it('stores the secret read from stdin, without its trailing newline', async () => {
    const { rt, puts } = recording();
    const o = io();
    expect(await cmdCredentialAdd(rt, o, adding())).toBe(0);
    expect(puts).toEqual([
      {
        name: 'anthropic',
        req: {
          kind: 'api-key',
          consumer: 'inference',
          destination: { hosts: ['api.anthropic.com'] },
          endpoint: 'https://api.anthropic.com',
          secret: { key: 'sk-ant-api03-secret' },
        },
      },
    ]);
    expect(o.stderr).toContain('stored credential anthropic');
    expect(o.stdout).toBe('');
  });

  it('prints JSON with --json', async () => {
    const { rt } = recording();
    const o = io();
    expect(await cmdCredentialAdd(rt, o, adding({ json: true }))).toBe(0);
    expect(JSON.parse(o.stdout)).toEqual({ name: 'anthropic', status: 'stored' });
  });

  it('reads key=value lines for a kind with several secret fields', async () => {
    const { rt, puts } = recording();
    const o = io();
    const opts = adding({
      name: 'registry',
      kind: 'basic',
      consumer: 'sandbox-egress',
      hosts: ['ghcr.io'],
      endpoint: undefined,
      readStdin: async () => 'username=ada\npassword=p=ss,word\n\n',
    });
    expect(await cmdCredentialAdd(rt, o, opts)).toBe(0);
    expect(puts[0]!.req.secret).toEqual({ username: 'ada', password: 'p=ss,word' });
    expect(puts[0]!.req).not.toHaveProperty('endpoint');
  });

  it.each([
    ['an empty secret', { readStdin: async () => '\n' }, 'no secret on stdin'],
    ['a blank secret', { readStdin: async () => '   \n' }, 'no secret on stdin'],
    ['a multi-line secret', { readStdin: async () => 'one\ntwo\n' }, 'one line'],
    ['leading whitespace', { readStdin: async () => ' sk-ant-api03-x' }, 'whitespace'],
    ['a UTF-8 BOM', { readStdin: async () => '\uFEFFsk-ant-api03-x' }, 'whitespace'],
    [
      'a key= prefix',
      { readStdin: async () => 'key=sk-ant-api03-x\n' },
      'without a leading "key="',
    ],
    [
      'a missing field',
      {
        kind: 'basic',
        consumer: 'sandbox-egress',
        endpoint: undefined,
        readStdin: async () => 'username=ada\n',
      },
      'password=',
    ],
  ] as Array<[string, Partial<CredentialAddOptions>, string]>)(
    'exits 2 without storing anything for %s',
    async (_label, over, message) => {
      const { rt, puts } = recording();
      const o = io();
      expect(await cmdCredentialAdd(rt, o, adding(over))).toBe(2);
      expect(puts).toEqual([]);
      expect(o.stderr.join('\n')).toContain(message);
    },
  );

  // Everything that needs no secret is refused before stdin is read.
  it.each([
    ['a terminal on stdin', { stdinIsTTY: true }, 'pipe the secret'],
    ['no host', { hosts: [] }, 'at least one host'],
    ['a bad name', { name: 'Bad_Name' }, 'name:'],
    ['a multi-field kind for inference', { kind: 'basic' }, 'single-secret kind'],
    ['an endpoint that is not a URL', { endpoint: 'api.anthropic.com' }, 'absolute URL'],
    ['an endpoint with /v1', { endpoint: 'https://api.anthropic.com/v1' }, 'no /v1'],
    [
      '--endpoint for another consumer',
      { consumer: 'sandbox-egress', kind: 'bearer' },
      '--endpoint only applies to --consumer inference',
    ],
  ] as Array<[string, Partial<CredentialAddOptions>, string]>)(
    'exits 2 before reading stdin for %s',
    async (_label, over, message) => {
      const { rt, puts } = recording();
      const readStdin = vi.fn(async () => 'sk-ant-api03-secret');
      const o = io();
      expect(await cmdCredentialAdd(rt, o, adding({ readStdin, ...over }))).toBe(2);
      expect(readStdin).not.toHaveBeenCalled();
      expect(puts).toEqual([]);
      expect(o.stderr.join('\n')).toContain(message);
    },
  );

  it.each(['toString', 'constructor', 'hasOwnProperty'])(
    'treats --kind %s as an unknown kind',
    async (kind) => {
      const { rt, puts } = recording();
      const o = io();
      const opts = adding({
        kind,
        consumer: 'sandbox-egress',
        hosts: ['x.example'],
        endpoint: undefined,
        readStdin: async () => 'token=abc\n',
      });
      expect(await cmdCredentialAdd(rt, o, opts)).toBe(0);
      expect(puts[0]!.req.secret).toEqual({ token: 'abc' });
    },
  );

  it('says on stderr that it is reading stdin, and exits 130 on Ctrl-C while waiting', async () => {
    const { rt, puts } = recording();
    const ac = new AbortController();
    const o = io();
    const opts = adding({ signal: ac.signal, readStdin: () => new Promise<string>(() => {}) });
    const pending = cmdCredentialAdd(rt, o, opts);
    await vi.waitFor(() => expect(o.stderr).toContain('reading the secret from stdin…'));
    ac.abort();
    expect(await pending).toBe(130);
    expect(puts).toEqual([]);
    expect(o.stdout).toBe('');
  });

  it('names the fix for a mis-shaped inference secret without echoing it', async () => {
    const { rt, puts } = recording();
    const o = io();
    const opts = adding({ readStdin: async () => 'sk-ant-oat01-very-secret' });
    expect(await cmdCredentialAdd(rt, o, opts)).toBe(2);
    expect(puts).toEqual([]);
    expect(o.stderr.join('\n')).toContain('Authorization');
    expect(o.stderr.join('\n')).not.toContain('very-secret');
  });

  it('exits 1 when the control plane rejects it', async () => {
    const rt = testRuntime({
      cp: fakeControlPlane({
        putCredential: async () => {
          throw new ApiError('control-plane', 400, 'bad_request', 'unknown kind');
        },
      }),
    });
    const o = io();
    expect(await cmdCredentialAdd(rt, o, adding())).toBe(1);
    expect(o.stderr.join('\n')).toContain('unknown kind');
  });

  it('exits 2 when not logged in, before reading stdin', async () => {
    const readStdin = vi.fn(async () => 'x');
    const o = io();
    expect(await cmdCredentialAdd(testRuntime(loggedOut), o, adding({ readStdin }))).toBe(2);
    expect(readStdin).not.toHaveBeenCalled();
  });
});

describe('cmdCredentialDelete', () => {
  const owned = async () => [credential('anthropic')];

  it('deletes the credential', async () => {
    const deleteCredential = vi.fn(async () => undefined);
    const rt = testRuntime({ cp: fakeControlPlane({ listCredentials: owned, deleteCredential }) });
    const o = io();
    expect(await cmdCredentialDelete(rt, o, { name: 'anthropic', json: true })).toBe(0);
    expect(deleteCredential).toHaveBeenCalledWith('anthropic');
    expect(JSON.parse(o.stdout)).toEqual({ name: 'anthropic', status: 'deleted' });
  });

  it('exits 1 for a name the user owns no credential of, without deleting', async () => {
    const deleteCredential = vi.fn(async () => undefined);
    const rt = testRuntime({ cp: fakeControlPlane({ listCredentials: owned, deleteCredential }) });
    const o = io();
    expect(await cmdCredentialDelete(rt, o, { name: 'anthropc', json: true })).toBe(1);
    expect(deleteCredential).not.toHaveBeenCalled();
    expect(o.stdout).toBe('');
    expect(o.stderr).toContain('no credential named anthropc');
  });
});

describe('cmdBundleDelete', () => {
  const digest = 'sha256:' + 'a'.repeat(64);

  it('deletes the bundle', async () => {
    const deleteConfigBundle = vi.fn(async () => undefined);
    const rt = testRuntime({ cp: fakeControlPlane({ deleteConfigBundle }) });
    const o = io();
    expect(await cmdBundleDelete(rt, o, { digest, json: true })).toBe(0);
    expect(deleteConfigBundle).toHaveBeenCalledWith(digest);
    expect(JSON.parse(o.stdout)).toEqual({ digest, status: 'deleted' });
  });

  it('exits 2 for a malformed digest without calling the control plane', async () => {
    const deleteConfigBundle = vi.fn(async () => undefined);
    const rt = testRuntime({ cp: fakeControlPlane({ deleteConfigBundle }) });
    const o = io();
    expect(await cmdBundleDelete(rt, o, { digest: 'sha256:nope', json: false })).toBe(2);
    expect(deleteConfigBundle).not.toHaveBeenCalled();
    expect(o.stderr.join('')).toContain('sha256:<64 lowercase hex>');
  });

  it.each([
    ['config_bundle_not_found', 404, 'no config bundle with digest'],
    ['forbidden', 403, 'only the subject that uploaded'],
  ])('exits 1 on %s with a message about this bundle', async (code, status, text) => {
    const deleteConfigBundle = vi.fn(async () => {
      throw new ApiError(
        'control-plane',
        status,
        code,
        'only the subject that uploaded this bundle, or an admin, may delete it',
      );
    });
    const rt = testRuntime({ cp: fakeControlPlane({ deleteConfigBundle }) });
    const o = io();
    expect(await cmdBundleDelete(rt, o, { digest, json: true })).toBe(1);
    expect(o.stdout).toBe('');
    expect(o.stderr.join('')).toContain(text);
  });
});

describe('Ctrl-C', () => {
  it('exits 130 from a listing that is still waiting on the control plane', async () => {
    const ac = new AbortController();
    const rt = testRuntime({
      cp: fakeControlPlane({ listCredentials: () => new Promise(() => {}) }),
    });
    const o = io();
    const pending = cmdCredentials(rt, o, { json: false, signal: ac.signal });
    ac.abort();
    expect(await pending).toBe(130);
    expect(o.stdout).toBe('');
  });
});
