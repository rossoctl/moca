import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  ProvenanceStore,
  recordDigest,
  sha256Hex,
  verifyExport,
  type ProvenanceExport,
} from '../src/provenance.js';

const T0 = Date.parse('2026-11-03T20:00:00Z');
const freshDir = (): string => mkdtempSync(join(tmpdir(), 'cp-provenance-'));
const store = (dir = freshDir()): ProvenanceStore => new ProvenanceStore({ dir, now: () => T0 });

const GATE = Buffer.from('{"schema":"moca-gate-record/1","gate":{"passed":true}}\n');

/** A policy, then one template's create, gate, build and check: an onboarded template's chain. */
async function onboard(s: ProvenanceStore): Promise<{ policy: string; head: string }> {
  const policy = await s.append({
    stream: 'policy',
    kind: 'policy',
    subject: 'github:1001',
    body: { profiles: { benchmark: {} } },
  });
  const t = 'template/demo-app';
  await s.append({
    stream: t,
    kind: 'create',
    subject: 'github:1002',
    body: { image: 'registry.example/demo-app@sha256:ab', profile: 'benchmark' },
  });
  const gateSha = await s.putBlob(GATE);
  await s.append({
    stream: t,
    kind: 'gate',
    subject: 'github:1002',
    body: { record_sha256: gateSha, source: 'trusted-builder' },
  });
  await s.append({
    stream: t,
    kind: 'build',
    subject: 'host:host-1',
    body: { manifest_hash: 'sha256:cd' },
  });
  const check = await s.append({
    stream: t,
    kind: 'check',
    subject: 'policy',
    body: { policy: policy.digest, outcome: 'registered' },
  });
  return { policy: policy.digest, head: check.digest };
}

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [true, null], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[true,null]},"b":1}',
    );
  });
  it('refuses what a second implementation could encode differently', () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow(/integers/);
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ é: 1 })).toThrow(/ASCII/);
    expect(() => canonicalJson({ a: '\ud800' })).toThrow(/surrogate/);
    expect(() => canonicalJson(new Date(0))).toThrow();
  });
  it('keeps non-ASCII string values as JSON.stringify writes them', () => {
    expect(canonicalJson({ a: 'café ✓' })).toBe('{"a":"café ✓"}');
  });
});

describe('ProvenanceStore', () => {
  it('chains records by prev, names each by the sha256 of its bytes, and counts the head', async () => {
    const dir = freshDir();
    const s = store(dir);
    const { head } = await onboard(s);
    const chain = await s.chain('template/demo-app');
    expect(chain.map((r) => r.kind)).toEqual(['create', 'gate', 'build', 'check']);
    expect(chain.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(chain[0].prev).toBeNull();
    for (let i = 1; i < chain.length; i++) expect(chain[i].prev).toBe(recordDigest(chain[i - 1]));
    expect(await s.head('template/demo-app')).toEqual({
      stream: 'template/demo-app',
      head,
      count: 4,
    });
    for (const f of readdirSync(join(dir, 'records'))) {
      expect(`${sha256Hex(readFileSync(join(dir, 'records', f)))}.json`).toBe(f);
    }
    expect(chain[0].at).toBe('2026-11-03T20:00:00Z');
  });

  it('keeps one stream per template: another template starts at seq 1', async () => {
    const s = store();
    await onboard(s);
    const r = await s.append({
      stream: 'template/py312',
      kind: 'create',
      subject: 'github:1002',
      body: {},
    });
    expect(r.record.seq).toBe(1);
    expect(r.record.prev).toBeNull();
  });

  it('serializes concurrent appends to one stream: no two records share a seq', async () => {
    const s = store();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.append({ stream: 'template/t', kind: 'use', subject: 'policy', body: { n: i } }),
      ),
    );
    const chain = await s.chain('template/t');
    expect(chain.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('refuses a malformed stream, an unknown kind, a policy record outside the policy stream', async () => {
    const s = store();
    await expect(
      s.append({ stream: 'template/Bad', kind: 'create', subject: 'a', body: {} }),
    ).rejects.toThrow(/stream/);
    await expect(
      s.append({ stream: 'template/x', kind: 'nope' as never, subject: 'a', body: {} }),
    ).rejects.toThrow(/kind/);
    await expect(
      s.append({ stream: 'template/x', kind: 'policy', subject: 'a', body: {} }),
    ).rejects.toThrow(/policy stream/);
    await expect(
      s.append({ stream: 'policy', kind: 'create', subject: 'a', body: {} }),
    ).rejects.toThrow(/template stream/);
    await expect(
      s.append({ stream: 'template/x', kind: 'create', subject: '', body: {} }),
    ).rejects.toThrow(/subject/);
  });

  it('refuses to read a record whose file was edited', async () => {
    const dir = freshDir();
    const s = store(dir);
    const { head } = await onboard(s);
    const f = join(dir, 'records', `${head.slice(7)}.json`);
    writeFileSync(f, readFileSync(f, 'utf8').replace('registered', 'rejected'));
    await expect(s.chain('template/demo-app')).rejects.toThrow(/does not match its digest/);
  });

  it('stores a cited document byte for byte under its sha256', async () => {
    const s = store();
    const d = await s.putBlob(GATE);
    expect(d).toBe(`sha256:${sha256Hex(GATE)}`);
    expect((await s.getBlob(d))?.equals(GATE)).toBe(true);
    expect(await s.putBlob(GATE)).toBe(d); // idempotent
  });

  it('writes a file once, refuses other bytes under its name, and leaves no temp file', async () => {
    const dir = freshDir();
    const s = store(dir);
    const d = await s.putBlob(GATE);
    const blob = join(dir, 'blobs', d.slice('sha256:'.length));
    // A file under the name with other bytes (not one the store wrote) is never overwritten.
    writeFileSync(blob, 'other bytes');
    await expect(s.putBlob(GATE)).rejects.toThrow(/exists with other bytes/);
    expect(readFileSync(blob, 'utf8')).toBe('other bytes');
    expect(readdirSync(join(dir, 'blobs')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const dir2 = freshDir();
    await onboard(store(dir2));
    expect(readdirSync(join(dir2, 'records')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('survives a restart: a new store on the same directory continues the chain', async () => {
    const dir = freshDir();
    const { head } = await onboard(store(dir));
    const again = store(dir);
    const r = await again.append({
      stream: 'template/demo-app',
      kind: 'activate',
      subject: 'github:1002',
      body: {},
    });
    expect(r.record.prev).toBe(head);
    expect(r.record.seq).toBe(5);
  });
});

describe('export and offline verification', () => {
  const exported = async (): Promise<ProvenanceExport> => {
    const s = store();
    await onboard(s);
    return JSON.parse(JSON.stringify(await s.export(['template/demo-app'])));
  };

  it('exports the template stream, the policy stream it cites and the gate record; verifies', async () => {
    const doc = await exported();
    expect(doc.streams.map((h) => h.stream).sort()).toEqual(['policy', 'template/demo-app']);
    expect(doc.blobs).toHaveLength(1);
    expect(verifyExport(doc)).toMatchObject({ ok: true, errors: [] });
  });

  it.each([
    ['an edited body', (d: ProvenanceExport) => (d.records[1].body.profile = 'base'), /prev|head/],
    [
      'a dropped middle record',
      (d: ProvenanceExport) => d.records.splice(2, 1),
      /seq|prev|records/,
    ],
    ['a reordered stream', (d: ProvenanceExport) => d.records.reverse(), /seq|prev/],
    [
      'a moved head',
      (d: ProvenanceExport) => (d.streams[0].head = `sha256:${'0'.repeat(64)}`),
      /head says/,
    ],
    [
      'an edited gate record',
      (d: ProvenanceExport) => (d.blobs[0].base64 = Buffer.from('{}').toString('base64')),
      /blob/,
    ],
    ['a dropped gate record', (d: ProvenanceExport) => d.blobs.pop(), /gate cites/],
    [
      'a check citing no policy record',
      (d: ProvenanceExport) => {
        const c = d.records.find((r) => r.kind === 'check')!;
        c.body.policy = `sha256:${'1'.repeat(64)}`;
      },
      /check cites policy/,
    ],
    ['a stream with no head', (d: ProvenanceExport) => d.streams.splice(0, 1), /no head/],
  ])('fails on %s', async (_name, edit, want) => {
    const doc = await exported();
    edit(doc);
    const v = verifyExport(doc);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(want);
  });
});

// The stdlib-only verifier an auditor runs (deploy/sbx/template-onboarding/verify-provenance.py)
// must agree with verifyExport on every export: run it on the good one and on each tampered one.
const VERIFIER = resolve(__dirname, '../../../deploy/sbx/template-onboarding/verify-provenance.py');
const havePython = spawnSync('python3', ['--version']).status === 0;
const runVerifier = (
  doc: ProvenanceExport,
  ...args: string[]
): { status: number | null; out: string } => {
  const f = join(freshDir(), 'export.json');
  writeFileSync(f, JSON.stringify(doc));
  const r = spawnSync('python3', [VERIFIER, f, ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

describe.skipIf(!havePython)('verify-provenance.py agrees with verifyExport', () => {
  it('verifies a good export, with non-ASCII text and nesting in bodies', async () => {
    const s = store();
    await onboard(s);
    await s.append({
      stream: 'template/demo-app',
      kind: 'use',
      subject: 'policy',
      body: { note: 'café ✓ "quoted" \\ \u0001', nested: { b: [1, -2, true, null], a: '' } },
    });
    const doc = JSON.parse(JSON.stringify(await s.export(['template/demo-app'])));
    expect(verifyExport(doc).ok).toBe(true);
    const r = runVerifier(doc);
    expect(r.out).toContain('ok template/demo-app: 5 records');
    expect(r.status).toBe(0);
  });

  it('verifies a store holding the sandbox kind, with its lease a record digest', async () => {
    const s = store();
    await onboard(s);
    const act = await s.append({
      stream: 'template/demo-app',
      kind: 'activate',
      subject: 'github:1001',
      body: { buildId: 'sha256:' + 'a'.repeat(64), leaseSeconds: 3600 },
    });
    await s.append({
      stream: 'template/demo-app',
      kind: 'sandbox',
      subject: 'github:1001',
      body: {
        sandboxId: 'sbx-1',
        buildId: 'sha256:' + 'a'.repeat(64),
        lease: act.digest,
        state: 'created',
      },
    });
    const doc = JSON.parse(JSON.stringify(await s.export(['template/demo-app'])));
    expect(verifyExport(doc).ok).toBe(true);
    const r = runVerifier(doc);
    expect(r.status).toBe(0);
    expect(r.out).toContain('ok template/demo-app: 6 records');
  });

  it('verifies a store holding the session kind, created and terminated', async () => {
    const s = store();
    await onboard(s);
    const act = await s.append({
      stream: 'template/demo-app',
      kind: 'activate',
      subject: 'github:1001',
      body: { buildId: 'sha256:' + 'a'.repeat(64), leaseSeconds: 3600 },
    });
    for (const body of [
      {
        sessionId: 'sess-1',
        buildId: 'sha256:' + 'a'.repeat(64),
        templateManifestHash: 'sha256:' + 'a'.repeat(64),
        lease: act.digest,
        state: 'created',
      },
      {
        sessionId: 'sess-1',
        buildId: 'sha256:' + 'a'.repeat(64),
        state: 'terminated',
        reason: 'deleted',
        endedAt: 1,
      },
    ]) {
      await s.append({
        stream: 'template/demo-app',
        kind: 'session',
        subject: 'github:1001',
        body,
      });
    }
    const doc = JSON.parse(JSON.stringify(await s.export(['template/demo-app'])));
    expect(verifyExport(doc).ok).toBe(true);
    const r = runVerifier(doc);
    expect(r.status).toBe(0);
    expect(r.out).toContain('ok template/demo-app: 7 records');
  });

  it('fails where verifyExport fails', async () => {
    const s = store();
    await onboard(s);
    const doc = JSON.parse(
      JSON.stringify(await s.export(['template/demo-app'])),
    ) as ProvenanceExport;
    doc.records[1].body.profile = 'base';
    expect(verifyExport(doc).ok).toBe(false);
    const r = runVerifier(doc);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL/);
  });

  it('refuses a kind it does not know, as verifyExport does', async () => {
    const s = store();
    await onboard(s);
    const doc = JSON.parse(
      JSON.stringify(await s.export(['template/demo-app'])),
    ) as ProvenanceExport;
    (doc.records[doc.records.length - 1] as { kind: string }).kind = 'later-kind';
    expect(verifyExport(doc).errors.join('\n')).toMatch(/unknown kind later-kind/);
    const r = runVerifier(doc);
    expect(r.status).toBe(1);
    expect(r.out).toContain('unknown kind later-kind');
  });

  it('exits 2 on a usage error', async () => {
    const doc = JSON.parse(JSON.stringify(await store().export([]))) as ProvenanceExport;
    expect(runVerifier(doc, '--head', 'policy=not-a-digest').status).toBe(2);
    expect(runVerifier(doc, '--bogus').status).toBe(2);
  });

  it('compares a head kept elsewhere (--head), which catches a truncated export', async () => {
    const s = store();
    const { head } = await onboard(s);
    await s.append({
      stream: 'template/demo-app',
      kind: 'activate',
      subject: 'github:1002',
      body: {},
    });
    const doc = JSON.parse(
      JSON.stringify(await s.export(['template/demo-app'])),
    ) as ProvenanceExport;
    // Truncate to the state before the activate: self-consistent, so only the kept head can tell.
    doc.records = doc.records.filter((r) => r.kind !== 'activate');
    const h = doc.streams.find((x) => x.stream === 'template/demo-app')!;
    h.head = head;
    h.count = 4;
    expect(verifyExport(doc).ok).toBe(true);
    const kept = (await s.head('template/demo-app'))!.head;
    const r = runVerifier(doc, '--head', `template/demo-app=${kept}`);
    expect(r.status).toBe(1);
    expect(r.out).toContain('the kept head is');
  });
});

// redact-provenance.py rewrites one template's stream from its first match on, moves the head, and
// logs counts only; the store and both verifiers accept the result, and an older export no longer
// matches the new head.
const REDACT = resolve(__dirname, '../../../deploy/sbx/template-onboarding/redact-provenance.py');

describe.skipIf(!havePython)('redact-provenance.py', () => {
  const T = 'template/demo-app';
  const redact = (...args: string[]) => {
    const r = spawnSync('python3', [REDACT, ...args], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('dry-runs by default, then rewrites the chain from the first match and moves the head', async () => {
    const dir = freshDir();
    const s = store(dir);
    await onboard(s);
    await s.append({
      stream: T,
      kind: 'use',
      subject: 'policy',
      body: { note: 'contains SECRET-TOKEN-1 by mistake' },
    });
    await s.append({ stream: T, kind: 'activate', subject: 'github:1002', body: {} });
    const before = JSON.parse(JSON.stringify(await s.export([T]))) as ProvenanceExport;
    const oldHead = (await s.head(T))!.head;

    const dry = redact(dir, 'demo-app', '--pattern', 'SECRET-TOKEN-[0-9]+');
    expect(dry.status).toBe(0);
    expect(dry.out).toContain('6 records, 1 match');
    expect((await s.head(T))!.head).toBe(oldHead);

    const applied = redact(dir, 'demo-app', '--pattern', 'SECRET-TOKEN-[0-9]+', '--apply');
    expect(applied.status).toBe(0);
    expect(applied.out).toContain('rewrote 2 records');
    expect(applied.out).not.toContain('SECRET-TOKEN');

    const again = store(dir);
    const chain = await again.chain(T);
    expect(chain.map((r) => r.kind)).toEqual([
      'create',
      'gate',
      'build',
      'check',
      'use',
      'activate',
    ]);
    expect(chain[4].body.note).toBe('contains <redacted> by mistake');
    const newHead = (await again.head(T))!;
    expect(newHead).toMatchObject({ count: 6 });
    expect(newHead.head).not.toBe(oldHead);
    for (const f of readdirSync(join(dir, 'records'))) {
      expect(readFileSync(join(dir, 'records', f), 'utf8')).not.toContain('SECRET-TOKEN');
    }
    const log = readFileSync(join(dir, 'redactions.log'), 'utf8');
    expect(JSON.parse(log)).toMatchObject({
      stream: T,
      old_head: oldHead,
      new_head: newHead.head,
      records_rewritten: 2,
    });
    expect(log).not.toContain('SECRET-TOKEN');

    // The redacted store exports and verifies; the export taken before no longer matches its head.
    const after = JSON.parse(JSON.stringify(await again.export([T]))) as ProvenanceExport;
    expect(verifyExport(after).ok).toBe(true);
    expect(runVerifier(after, '--head', `${T}=${newHead.head}`).status).toBe(0);
    expect(verifyExport(before).ok).toBe(true);
    expect(runVerifier(before, '--head', `${T}=${newHead.head}`).status).toBe(1);
    // The chain continues from the new head.
    expect(
      (await again.append({ stream: T, kind: 'use', subject: 'policy', body: {} })).record,
    ).toMatchObject({ seq: 7, prev: newHead.head });
  });

  it('says nothing to redact when nothing matches, and refuses a stream with no head', async () => {
    const dir = freshDir();
    await onboard(store(dir));
    const none = redact(dir, 'demo-app', '--pattern', 'no-such-text', '--apply');
    expect(none.status).toBe(0);
    expect(none.out).toContain('nothing to redact');
    expect(redact(dir, 'other-app', '--pattern', 'x').status).toBe(2);
    expect(redact(dir, 'demo-app').status).toBe(2);
  });
});

// verify-provenance.py --egress SANDBOX_ID=FILE, an optional, additive check of a
// sandbox's exported egress log against the egress its newest `sandbox` record names.
describe.skipIf(!havePython)('verify-provenance.py --egress', () => {
  const TPL = 'template/demo-app';
  const SBX = 'sbx-0123456789abcdef0123456789';
  const NDJSON =
    '{"bytes_down":20,"bytes_up":10,"decision":"tunnel","host":"pypi.example.com","sid":"sbx-0123456789abcdef0123456789","status":200,"time":"2026-11-08T12:00:00Z","via":"moca-egress"}\n' +
    '{"bytes_down":0,"bytes_up":0,"decision":"destination_denied","host":"files.example.com","method":"GET","path":"/x/","sid":"sbx-0123456789abcdef0123456789","status":403,"time":"2026-11-08T12:00:01Z","via":"moca-egress"}\n';
  const egressOf = (data: string, over: Record<string, unknown> = {}) => ({
    events: data.split('\n').length - 1,
    sha256: `sha256:${sha256Hex(Buffer.from(data, 'utf8'))}`,
    dropped: 0,
    complete: true,
    ...over,
  });
  const ended = async (egress?: Record<string, unknown>, late?: Record<string, unknown>) => {
    const s = store();
    await onboard(s);
    await s.append({
      stream: TPL,
      kind: 'sandbox',
      subject: 'github:1',
      body: { sandboxId: SBX, buildId: null, state: 'created' },
    });
    await s.append({
      stream: TPL,
      kind: 'sandbox',
      subject: 'github:1',
      body: {
        sandboxId: SBX,
        buildId: null,
        state: 'terminated',
        reason: 'deleted',
        endedAt: 1,
        ...(egress ? { egress } : {}),
      },
    });
    if (late)
      await s.append({
        stream: TPL,
        kind: 'sandbox',
        subject: 'janitor',
        body: { sandboxId: SBX, buildId: null, state: 'egress', egress: late },
      });
    return JSON.parse(JSON.stringify(await s.export([TPL]))) as ProvenanceExport;
  };
  const file = (data: string) => {
    const f = join(freshDir(), 'egress.ndjson');
    writeFileSync(f, data);
    return f;
  };

  it('leaves the existing checks unchanged: a copy without any egress record verifies, rc 0', async () => {
    const doc = await ended();
    expect(verifyExport(doc).ok).toBe(true);
    const r = runVerifier(doc);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`ok ${TPL}: 6 records`);
    expect(r.out).not.toContain('egress');
    // A copy with an egress record verifies the same way when --egress is not given.
    const withEgress = runVerifier(await ended(egressOf(NDJSON)));
    expect(withEgress.status).toBe(0);
    expect(withEgress.out).not.toContain('egress');
  });

  it("checks a log's sha256 and line count against its end record, and says when it is incomplete", async () => {
    const ok = runVerifier(await ended(egressOf(NDJSON)), '--egress', `${SBX}=${file(NDJSON)}`);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain(`ok egress ${SBX}: 2 events, sha256:`);
    expect(ok.out).toContain('complete');
    const inc = runVerifier(
      await ended(egressOf(NDJSON, { dropped: 3, complete: false })),
      '--egress',
      `${SBX}=${file(NDJSON)}`,
    );
    expect(inc.status).toBe(0);
    expect(inc.out).toContain('INCOMPLETE, 3 dropped');
    // With the record's droppedBy, the line names the reasons.
    const why = runVerifier(
      await ended(
        egressOf(NDJSON, {
          dropped: 5,
          complete: false,
          droppedBy: { proxy: 0, cap: 0, budget: 4, invalid: 1 },
        }),
      ),
      '--egress',
      `${SBX}=${file(NDJSON)}`,
    );
    expect(why.status).toBe(0);
    expect(why.out).toContain('INCOMPLETE, 5 dropped (budget 4, invalid 1)');
  });

  it('takes the newest record naming egress: a later state: egress record wins over the end record', async () => {
    const more = `${NDJSON}{"decision":"aborted","time":"2026-11-08T12:00:02Z","via":"moca-egress"}\n`;
    const doc = await ended(egressOf(NDJSON), egressOf(more));
    expect(runVerifier(doc, '--egress', `${SBX}=${file(more)}`).status).toBe(0);
    const old = runVerifier(doc, '--egress', `${SBX}=${file(NDJSON)}`);
    expect(old.status).toBe(1);
    expect(old.out).toContain('the record names');
  });

  it('fails on a changed log, a missing record, and refuses an unreadable file (rc 2)', async () => {
    const doc = await ended(egressOf(NDJSON));
    const changed = runVerifier(doc, '--egress', `${SBX}=${file(NDJSON.replace('10', '11'))}`);
    expect(changed.status).toBe(1);
    expect(changed.out).toContain("the file's sha256 is");
    const none = runVerifier(await ended(), '--egress', `${SBX}=${file(NDJSON)}`);
    expect(none.status).toBe(1);
    expect(none.out).toContain('no sandbox record of the export names its egress log');
    expect(runVerifier(doc, '--egress', `${SBX}=/nonexistent/x`).status).toBe(2);
    expect(runVerifier(doc, '--egress', SBX).status).toBe(2);
  });

  it('fails closed on a record whose events is not an int count or whose sha256 is not sha256:<64 hex>', async () => {
    const one = NDJSON.split('\n')[0]! + '\n';
    // In Python True == 1: a one-line file must not match `events: true`. (Canonical JSON holds
    // integers only, so a float cannot be in an export at all.)
    for (const events of [true, '1', -1]) {
      const r = runVerifier(
        await ended(egressOf(one, { events })),
        '--egress',
        `${SBX}=${file(one)}`,
      );
      expect(r.status).toBe(1);
      expect(r.out).toContain("the record's events is");
    }
    for (const sha256 of ['x', 42, `sha256:${'A'.repeat(64)}`]) {
      const r = runVerifier(
        await ended(egressOf(one, { sha256 })),
        '--egress',
        `${SBX}=${file(one)}`,
      );
      expect(r.status).toBe(1);
      expect(r.out).toContain("the record's sha256 is");
      expect(r.out).toContain('not sha256:<64 hex>');
    }
  });
});
