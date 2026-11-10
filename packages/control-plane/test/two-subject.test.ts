import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { startControlPlane } from '../src/server.js';
import { MemoryTurnQueue } from '../src/turn-queue.js';
import { makeDeps, seedCredential, type TestDeps } from './helpers/deps.js';

// The #367 scope-item-3 suite: the two-subject story the VM demo runs manually (two mocactl users
// against the P6 VM), rehearsed end to end over real HTTP without GitHub. What the existing
// cross-tenant suites (`handlers-sessions`, `route-authz-enumeration`) prove at HANDLER level with
// hand-built principals, this file proves over the wire with the stand-in the demo smoke uses: api
// tokens minted by the control plane's own signing key, exactly as `deploy/compose/smoke.sh` does.
// That shape is what catches wiring regressions the handler tests cannot see — router auth order,
// header handling, JSON envelopes, scope enforcement against real signed tokens.

let server: ReturnType<typeof startControlPlane>;
let base: string;
let d: TestDeps;

function request(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; json(): unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(path, base),
      { method: method, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode ?? 0,
            body,
            json: () => (body ? JSON.parse(body) : undefined),
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) {
      req.setHeader('Content-Type', 'application/json');
      req.write(JSON.stringify(opts.body));
    }
    req.end();
  });
}

beforeEach(async () => {
  d = makeDeps({ config: { exchangeToken: 'shared-abc' } }); // notsecret
  await seedCredential(d, 'github:1234');
  await seedCredential(d, 'github:9999');
  server = startControlPlane(d, 0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  server.close();
});

/**
 * The smoke.sh stand-in for a device-flow login (#367 current state): an api-scoped token minted by
 * the control plane's own signing key, naming an arbitrary subject. The demo itself uses real
 * GitHub logins; this file must run without GitHub.
 */
function apiToken(sub: string): string {
  return d.signer.mint({ sub, tenant: sub, roles: [], scope: ['api'], ttlSeconds: 900 });
}

const ALICE = 'github:1234';
const BOB = 'github:9999';

/** Create a session over HTTP as `sub`, asserting 201 so a broken fixture fails loudly. */
async function createSession(
  sub: string,
  id: string,
): Promise<{ sessionId: string; token: string }> {
  const saved = d.newId;
  d.newId = () => id;
  try {
    const res = await request('POST', '/v1/sessions', {
      body: {},
      headers: { Authorization: `Bearer ${apiToken(sub)}` },
    });
    expect(res.status, `creating ${id} as ${sub}`).toBe(201);
    return res.json() as { sessionId: string; token: string };
  } finally {
    d.newId = saved;
  }
}

async function sessionIds(sub: string): Promise<string[]> {
  const res = await request('GET', '/v1/sessions', {
    headers: { Authorization: `Bearer ${apiToken(sub)}` },
  });
  expect(res.status).toBe(200);
  return (res.json() as { sessions: { sessionId: string }[] }).sessions.map((s) => s.sessionId);
}

describe('two minted subjects over HTTP (#367 scope item 3)', () => {
  it('both tokens pass the router auth and name their own subject', async () => {
    for (const sub of [ALICE, BOB]) {
      const res = await request('GET', '/v1/me', {
        headers: { Authorization: `Bearer ${apiToken(sub)}` },
      });
      expect(res.status, sub).toBe(200);
      expect(res.json()).toEqual({ subject: sub, tenant: sub, roles: [] });
    }
  });

  it('a turn:write-scoped token is 401 on /v1/sessions — the minted stand-in cannot blur scopes', async () => {
    const turnScoped = d.signer.mint({
      sub: ALICE,
      tenant: ALICE,
      roles: [],
      scope: ['turn:write'],
      ttlSeconds: 900,
    });
    const res = await request('GET', '/v1/sessions', {
      headers: { Authorization: `Bearer ${turnScoped}` },
    });
    expect(res.status).toBe(401);
  });

  it('each subject lists only their own sessions', async () => {
    await createSession(ALICE, 'a-1');
    await createSession(BOB, 'b-1');
    expect(await sessionIds(ALICE)).toEqual(['a-1']);
    expect(await sessionIds(BOB)).toEqual(['b-1']);
  });

  it("alice's GET of bob's session 404s identically to an unknown id", async () => {
    await createSession(BOB, 'b-1');
    const cross = await request('GET', '/v1/sessions/b-1', {
      headers: { Authorization: `Bearer ${apiToken(ALICE)}` },
    });
    const unknown = await request('GET', '/v1/sessions/never-existed', {
      headers: { Authorization: `Bearer ${apiToken(ALICE)}` },
    });
    // Over the wire the two must be indistinguishable in status and error code — the
    // no-existence-oracle property the handler tests pin, checked here as an HTTP client sees it.
    // The body echoes the REQUESTED sessionId (the caller named it), so only the shape beyond that
    // echo can be compared: same status, same error code.
    expect(cross.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(cross.json()).toEqual({ error: 'session_not_found', sessionId: 'b-1' });
    expect(unknown.json()).toEqual({ error: 'session_not_found', sessionId: 'never-existed' });
  });

  it("alice's DELETE of bob's session 404s and destroys nothing", async () => {
    await createSession(BOB, 'b-1');
    const res = await request('DELETE', '/v1/sessions/b-1', {
      headers: { Authorization: `Bearer ${apiToken(ALICE)}` },
    });
    expect(res.status).toBe(404);
    expect((res.json() as { error: string }).error).toBe('session_not_found');
    expect(await sessionIds(BOB)).toEqual(['b-1']);
  });

  it("alice cannot re-mint a session token for bob's session", async () => {
    await createSession(BOB, 'b-1');
    const res = await request('POST', '/v1/sessions/b-1/token', {
      headers: { Authorization: `Bearer ${apiToken(ALICE)}` },
    });
    expect(res.status).toBe(404);
    expect((res.json() as { error: string }).error).toBe('session_not_found');
  });

  it('the exchange refuses a session token whose subject is not the record owner', async () => {
    // The control-plane half of the cross-drive refusal: even if the harness tier were bypassed, the
    // credential exchange must not hand alice's key out against a session she does not own. Shape
    // from exchange.test.ts's "refuses a token whose subject is not the session's owner": alice
    // holds a valid turn:write token for a-1, and the record for a-1 is re-pointed at bob (verify
    // the re-point before asserting the refusal, so the test cannot pass on a broken fixture).
    const created = await createSession(ALICE, 'a-1');
    const rec = await d.index.get('a-1');
    expect(rec?.owner).toBe(ALICE); // the fixture is what we think it is before we break it
    // The re-point deliberately leaves the owner zset stale: `create` zAdds to BOB's index without
    // zRem-ing ALICE's, so a-1 sits in both sorted sets after this line. Production never reaches
    // that state (a session is created once, under one owner); it is harmless here because the
    // exchange goes through `index.get` (the hash), not `listByOwner`. Do NOT add a `listByOwner`
    // assertion below the re-point without fixing the fake's zset bookkeeping first.
    await d.index.create({ ...rec!, owner: BOB });
    expect((await d.index.get('a-1'))?.owner).toBe(BOB);

    const res = await request('POST', '/internal/credentials', {
      body: { token: created.token },
      headers: { Authorization: 'Bearer shared-abc' }, // notsecret
    });
    expect(res.status).toBe(404);
    expect((res.json() as { error: string }).error).toBe('session_not_found');
  });

  it("alice cannot submit an async turn on bob's session, and nothing is queued", async () => {
    await createSession(BOB, 'b-1');
    const res = await request('POST', '/v1/sessions/b-1/turns', {
      body: { async: true, prompt: 'go' },
      headers: { Authorization: `Bearer ${apiToken(ALICE)}` },
    });
    // 404, not 403: a distinguishable answer tells alice bob's session exists (spec §8.1).
    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: 'session_not_found', sessionId: 'b-1' });
    expect((d.turnQueue as MemoryTurnQueue).depth()).toBe(0);
  });

  it("alice's read of bob's turn 404s identically to an unknown turn id", async () => {
    await createSession(BOB, 'b-1');
    const submitted = await request('POST', '/v1/sessions/b-1/turns', {
      body: { async: true, kind: 'prompt', prompt: 'go' },
      headers: { Authorization: `Bearer ${apiToken(BOB)}` },
    });
    expect(submitted.status).toBe(202);
    const { turnId } = submitted.json() as { turnId: string };
    const cross = await request(`GET`, `/v1/sessions/b-1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${apiToken(ALICE)}` },
    });
    const unknown = await request('GET', '/v1/sessions/b-1/turns/never-existed', {
      headers: { Authorization: `Bearer ${apiToken(ALICE)}` },
    });
    // Both refusals come from the SESSION check, before the turn is looked at at all -- so knowing
    // a real turn id buys alice nothing.
    expect(cross.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(cross.json()).toEqual(unknown.json());
  });

  it("alice's DELETE of bob's turn 404s and leaves it queued", async () => {
    await createSession(BOB, 'b-1');
    const { turnId } = (
      await request('POST', '/v1/sessions/b-1/turns', {
        body: { async: true, kind: 'prompt', prompt: 'go' },
        headers: { Authorization: `Bearer ${apiToken(BOB)}` },
      })
    ).json() as { turnId: string };
    const res = await request('DELETE', `/v1/sessions/b-1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${apiToken(ALICE)}` },
    });
    expect(res.status).toBe(404);
    // The refusal must not be a cancel: a 404 that still cancelled would be a denial of service
    // dressed as an authorization failure.
    const mine = await request(`GET`, `/v1/sessions/b-1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${apiToken(BOB)}` },
    });
    expect(mine.json()).toMatchObject({ state: 'queued' });
  });
});
