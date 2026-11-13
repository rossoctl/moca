// Enforcement tests for ADR-0044 (identifiers-only audit-log mirror). Captures emitted lines
// in-process via makeDeps's push-to-array log; see sandbox-handlers.test.ts for the console-stub
// variant.

import { describe, expect, it, vi } from 'vitest';
import { defaultAuditLog } from '../src/audit-log.js';
import { HANDLERS } from '../src/handlers.js';
import { alice, bob, ctx, makeDeps, seedCredential } from './helpers/deps.js';

const PLANTED_TOKEN = 'PLANTED-SECRET-TOKEN-abcdef123'; // notsecret
const PLANTED_PROMPT = 'PLANTED-PROMPT-TEXT-αβγ';
const PLANTED_FILENAME = 'PLANTED-FILENAME.txt';
const PLANTED_DISPLAY = 'PLANTED-DISPLAY-NAME';
const PLANTED_SKILL = 'PLANTED-SKILL-BODY';

// Closed field whitelist for emitted lines; drift here fails this test.
const ALLOWED_KEYS = new Set([
  'event',
  'decision',
  'subject',
  'sessionId',
  'workloadId',
  'configRef',
  'sandboxId',
  'credential',
  'model',
  'fromModel',
  'fromMode',
  'toMode',
  'modeEpoch',
  'kind',
  'status',
  'reason',
  'bytes',
  'writable',
  'family',
  'graceReplay', // boolean, not customer data; marks a Lua grace-replay rotation
  'reaper', // boolean; marks a run_finalized written by the run-lease reaper, not the holder (#558)
  'leafSid',
  'attempt',
]);

// Field names that must NEVER appear as keys regardless of their values.
// Lowercased because the test compares against key.toLowerCase() below.
const FORBIDDEN_KEYS = [
  'token',
  'secret',
  'password',
  'apikey',
  'bearer',
  'authorization',
  'credentialvalue',
  'prompt',
  'prompttext',
  'body',
  'contents',
  'response',
  'text',
  'output',
  'email',
  'displayname',
  'label',
];

function lineToSearchable(line: Record<string, unknown>): string {
  return JSON.stringify(line);
}

/**
 * Drive the full control-plane handler surface that audits. Not every call succeeds (some are
 * refusals -- that's part of the coverage), but every call must emit at least one line.
 */
async function driveAuditingRoutes(
  deps: ReturnType<typeof makeDeps>,
  subject = alice,
): Promise<void> {
  // createSession
  await HANDLERS.createSession!(
    ctx({ principal: subject, body: { credential: 'my-anthropic' } }),
    deps,
  ).catch(() => {});
  // model_changed via updateSession
  await HANDLERS.updateSession!(
    ctx({ principal: subject, params: { id: 'sid-fixed' }, body: { model: 'claude-sonnet-5' } }),
    deps,
  ).catch(() => {});
  // credential_written
  await HANDLERS.putCredential!(
    ctx({
      principal: subject,
      params: { name: 'cred-' + subject.sub.slice(-4) },
      body: {
        kind: 'bearer',
        consumer: 'inference',
        destination: { hosts: ['litellm.internal'] },
        endpoint: 'https://litellm.internal/v1',
        secret: { token: PLANTED_TOKEN },
      },
    }),
    deps,
  ).catch(() => {});
  // credential_deleted
  await HANDLERS.deleteCredential!(
    ctx({ principal: subject, params: { name: 'cred-' + subject.sub.slice(-4) } }),
    deps,
  ).catch(() => {});
  // config_bundle_deleted (upload path requires signed body; delete alone exercises the audit site)
  const fakeDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  await HANDLERS.deleteConfigBundle!(
    ctx({ principal: subject, params: { digest: fakeDigest } }),
    deps,
  ).catch(() => {});
  // session_deleted
  await HANDLERS.deleteSession!(
    ctx({ principal: subject, params: { id: 'sid-fixed' } }),
    deps,
  ).catch(() => {});
}

describe('audit-log module', () => {
  it('defaultAuditLog emits one JSON line via console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    defaultAuditLog({
      event: 'audit',
      decision: 'session_created',
      subject: 'github:1',
      sessionId: 's',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({
      event: 'audit',
      decision: 'session_created',
      subject: 'github:1',
      sessionId: 's',
    });
    spy.mockRestore();
  });
});

describe('data-handling policy across the auditing surface', () => {
  // Refresh-store mirror (RedisRefreshStore) is covered in refresh-redis.test.ts, which runs
  // against a real Redis and passes a capturing `log` as the 4th constructor arg. The three
  // tests here exercise the control-plane handler seams only.

  it('no planted token appears in any emitted line (#359)', async () => {
    const deps = makeDeps();
    await seedCredential(deps, alice.sub, 'my-anthropic', { secret: { token: PLANTED_TOKEN } });
    await driveAuditingRoutes(deps);

    // Sanity floor: a regression that stops emission must not silently shrink the array.
    const decisions = new Set(deps.logLines.map((l) => l.decision));
    expect(decisions.has('session_created'), 'session_created should emit').toBe(true);

    for (const line of deps.logLines) {
      const text = lineToSearchable(line);
      expect(text, `token leaked in line: ${text}`).not.toContain(PLANTED_TOKEN);
      // No JWT-shaped substring (eyJ... — base64url header).
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    }
  });

  it('no planted user content (prompt / filename / display name / skill body) appears', async () => {
    const deps = makeDeps();
    await seedCredential(deps, alice.sub);
    await driveAuditingRoutes(deps);

    expect(deps.logLines.length).toBeGreaterThan(0);
    for (const line of deps.logLines) {
      const text = lineToSearchable(line);
      for (const planted of [PLANTED_PROMPT, PLANTED_FILENAME, PLANTED_DISPLAY, PLANTED_SKILL]) {
        expect(text, `user content leaked: ${planted}`).not.toContain(planted);
      }
    }
  });

  it('every emitted line uses only whitelisted field keys', async () => {
    const deps = makeDeps();
    await seedCredential(deps, alice.sub);
    await driveAuditingRoutes(deps);

    expect(deps.logLines.length).toBeGreaterThan(0);
    for (const line of deps.logLines) {
      for (const key of Object.keys(line)) {
        expect(
          ALLOWED_KEYS.has(key),
          `off-whitelist key ${JSON.stringify(key)} in ${JSON.stringify(line)}`,
        ).toBe(true);
        expect(
          FORBIDDEN_KEYS,
          `forbidden key ${JSON.stringify(key)} in ${JSON.stringify(line)}`,
        ).not.toContain(key.toLowerCase());
      }
    }
  });
});

describe('concurrent-subject attribution', () => {
  it('two sessions created in parallel attribute each subject to its own sessionId', async () => {
    const deps = makeDeps();
    await seedCredential(deps, alice.sub);
    await seedCredential(deps, bob.sub);

    // Each call gets its own sessionId; the test asserts the emitted lines pair each subject
    // with the sessionId its own createSession response returned (not just that two distinct
    // subjects showed up).
    let n = 0;
    deps.newId = () => `sid-${++n}`;
    const [aliceRes, bobRes] = await Promise.all([
      HANDLERS.createSession!(
        ctx({ principal: alice, body: { credential: 'my-anthropic' } }),
        deps,
      ),
      HANDLERS.createSession!(ctx({ principal: bob, body: { credential: 'my-anthropic' } }), deps),
    ]);
    const aliceSid = (aliceRes.body as { sessionId: string }).sessionId;
    const bobSid = (bobRes.body as { sessionId: string }).sessionId;
    expect(aliceSid).not.toBe(bobSid);

    const sessionCreated = deps.logLines.filter((l) => l.decision === 'session_created');
    expect(sessionCreated).toHaveLength(2);
    const bySubject = new Map(sessionCreated.map((l) => [l.subject, l]));
    expect(bySubject.get(alice.sub)?.sessionId).toBe(aliceSid);
    expect(bySubject.get(bob.sub)?.sessionId).toBe(bobSid);
  });
});
