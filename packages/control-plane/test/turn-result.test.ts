import { describe, expect, it } from 'vitest';
import { clip, pickArtifact, projectLeafResult } from '../src/turn-result.js';

/**
 * The read-time projection the async status route answers with (#390, async spec §4.4). The point
 * of every test here is one sentence: the OUTPUT leaves the body and a description of it stays.
 */
describe('projectLeafResult (#390)', () => {
  const solved = {
    status: 'solved',
    verdict: null,
    gate: null,
    reason: null,
    patch: 'diff --git a/x b/x\n@@ -1 +1,2 @@\n-a\n+b\n+c\n',
    text: null,
    usage: { input_tokens: 10, output_tokens: 2 },
    sessionId: 's-1',
    ts: '2026-11-16T00:00:00.000Z',
    workspace: {
      baseline: 'a'.repeat(40),
      patchSha256: 'f'.repeat(64),
      patchBytes: 44,
      diffstat: { files: 1, insertions: 2, deletions: 1 },
    },
  };

  it('strips the patch and the assistant text, keeps everything else', () => {
    const out = projectLeafResult(solved, 2048);
    expect(out.patch).toBeUndefined();
    expect(out.text).toBeUndefined();
    // Not just "some patch field is gone": no part of the diff is anywhere in the body.
    expect(JSON.stringify(out)).not.toContain('diff --git');
    expect(out).toMatchObject({
      status: 'solved',
      usage: { input_tokens: 10, output_tokens: 2 },
      sessionId: 's-1',
      ts: '2026-11-16T00:00:00.000Z',
      workspace: {
        baseline: 'a'.repeat(40),
        patchSha256: 'f'.repeat(64),
        patchBytes: 44,
        diffstat: { files: 1, insertions: 2, deletions: 1 },
      },
    });
  });

  it('names the patch as a fetchable artifact, with its size and the capture s sha', () => {
    expect(projectLeafResult(solved, 2048).artifacts).toEqual([
      { kind: 'patch', bytes: Buffer.byteLength(solved.patch, 'utf8'), sha256: 'f'.repeat(64) },
    ]);
  });

  it('summarises a solve by its diffstat, a prompt by its text, a gate by its summary, a failure by its reason', () => {
    expect(projectLeafResult(solved, 2048).summary).toBe('1 files, +2 -1');
    expect(projectLeafResult({ ...solved, text: 'the repo builds' }, 2048).summary).toBe(
      'the repo builds',
    );
    expect(
      projectLeafResult(
        {
          status: 'paused',
          gate: { gateId: 1, summary: 'wants to push', proposed_action: 'push' },
        },
        2048,
      ).summary,
    ).toBe('wants to push');
    expect(projectLeafResult({ status: 'failed', reason: 'leaf exited 1' }, 2048).summary).toBe(
      'leaf exited 1',
    );
    // Nothing to summarise: no key at all rather than an empty string, so a client can tell
    // "no summary" from "the leaf said nothing".
    expect(projectLeafResult({ status: 'done', verdict: null }, 2048)).toEqual({
      status: 'done',
      verdict: null,
    });
  });

  it('clips the summary at the byte cap', () => {
    const out = projectLeafResult({ status: 'responded', text: 'x'.repeat(5000) }, 16);
    expect(out.summary).toBe('x'.repeat(16) + '…[truncated]');
  });

  it('omits the summary entirely at a cap of 0, which is what "no summary" means', () => {
    // Not `summary: '…[truncated]'`: a key holding nothing but the marker is not "no summary", and
    // `configuration.md` promises the key is gone.
    // The ARTIFACT survives the cap of 0, as the patch's does: naming what can be fetched is a
    // descriptor, not model prose, and it is the only thing left pointing at the reply.
    expect(projectLeafResult({ status: 'responded', text: 'x'.repeat(5000) }, 0)).toEqual({
      status: 'responded',
      artifacts: [{ kind: 'text', bytes: 5000 }],
    });
  });

  it('drops the verdict s reason and the gate s two lines at a cap of 0, keeping the rest', () => {
    // 0 means "no model prose in this body" (configuration.md), and these three are model prose just
    // as `summary` is -- a `reason` clipped to the bare `…[truncated]` marker would obey the cap in
    // bytes while ignoring what the operator asked for. The SHAPED fields stay: `verdict` is what a
    // client branches on, and dropping it at a cap of 0 would make the knob change the contract.
    const out = projectLeafResult(
      {
        status: 'done',
        verdict: { item_id: 'i-1', verdict: 'FLAGGED', reason: 'y'.repeat(5000) },
        gate: { gateId: 1, summary: 'g'.repeat(5000), proposed_action: 'p'.repeat(5000) },
      },
      0,
    );
    expect(out.verdict).toEqual({ item_id: 'i-1', verdict: 'FLAGGED' });
    expect(out.gate).toEqual({ gateId: 1 });
    expect(out.summary).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('truncated');
  });

  it('clips the OTHER model-written strings too: a verdict s reason and a gate s two lines', () => {
    // `validateVerdict` caps `reason` nowhere, so without this a `done` turn's body is as unbounded
    // as the patch this projection exists to remove -- on every poll.
    const out = projectLeafResult(
      {
        status: 'done',
        verdict: { item_id: 'i-1', verdict: 'FLAGGED', reason: 'y'.repeat(5000) },
        gate: { gateId: 1, summary: 'g'.repeat(5000), proposed_action: 'p'.repeat(5000) },
      },
      16,
    );
    expect(out.verdict).toEqual({
      item_id: 'i-1',
      verdict: 'FLAGGED',
      reason: 'y'.repeat(16) + '…[truncated]',
    });
    expect(out.gate).toEqual({
      gateId: 1,
      summary: 'g'.repeat(16) + '…[truncated]',
      proposed_action: 'p'.repeat(16) + '…[truncated]',
    });
    // The whole body, not just the three fields: nothing else smuggled the full strings through.
    expect(JSON.stringify(out)).not.toContain('yyyyyyyyyyyyyyyyy');
    expect(JSON.stringify(out)).not.toContain('ggggggggggggggggg');
  });

  it('leaves a null verdict and a null gate exactly as they were', () => {
    // `toResultRecord` writes both as null on most branches, and a client reads `verdict === null`
    // as "no verdict": clipping must not turn either into an object.
    expect(projectLeafResult({ status: 'failed', verdict: null, gate: null }, 2048)).toEqual({
      status: 'failed',
      verdict: null,
      gate: null,
    });
  });

  it('offers no PATCH artifact for a capture refused for size, and keeps the refusal visible', () => {
    const out = projectLeafResult(
      {
        status: 'responded',
        text: 'done',
        workspace: {
          patchRefused: 'too_large',
          patchBytes: 9_000_000,
          patchSha256: 'e'.repeat(64),
        },
      },
      2048,
    );
    // The bytes never left the sandbox, so there is nothing to fetch -- and the descriptor is the
    // whole answer about that patch. The reply itself is still fetchable, which on this record is
    // the only thing that is.
    expect(out.artifacts).toEqual([{ kind: 'text', bytes: 4 }]);
    expect(out.workspace).toEqual({
      patchRefused: 'too_large',
      patchBytes: 9_000_000,
      patchSha256: 'e'.repeat(64),
    });
  });

  it('describes a prompt leaf s workspace patch without decoding it', () => {
    const patch = Buffer.from('diff --git a/b b/b\n');
    const out = projectLeafResult(
      {
        status: 'responded',
        text: 'changed one file',
        workspace: { patchBase64: patch.toString('base64'), patchBytes: patch.byteLength },
      },
      2048,
    );
    // Patch first, then the reply: a prompt leaf that edited files has both to fetch.
    expect(out.artifacts).toEqual([
      { kind: 'patch', bytes: patch.byteLength },
      { kind: 'text', bytes: 16 },
    ]);
    expect(out.workspace).toEqual({ patchBytes: patch.byteLength });
  });

  it('survives a record from an older worker, which has no workspace at all', () => {
    expect(projectLeafResult({ status: 'solved', patch: 'diff --git a/x b/x\n' }, 2048)).toEqual({
      status: 'solved',
      artifacts: [{ kind: 'patch', bytes: 19 }],
    });
  });
});

describe('pickArtifact (#390)', () => {
  it('serves a solve patch, a prompt workspace patch, and a base64 one decoded', () => {
    expect(pickArtifact({ patch: 'diff a\n' }, 'patch')).toEqual({
      bytes: Buffer.from('diff a\n'),
      contentType: 'text/x-diff',
    });
    expect(pickArtifact({ workspace: { patch: 'diff b\n' } }, 'patch')?.bytes).toEqual(
      Buffer.from('diff b\n'),
    );
    // The binary-safe capture: a diff that is not valid UTF-8 is stored base64, and must come back
    // byte-exact rather than through a lossy string round trip.
    const raw = Buffer.from([0x64, 0x69, 0x66, 0x66, 0xff, 0xfe, 0x0a]);
    expect(
      pickArtifact({ workspace: { patchBase64: raw.toString('base64') } }, 'patch')?.bytes,
    ).toEqual(raw);
  });

  it('carries the capture s digest out, so the route need not re-hash the bytes', () => {
    // The same value `artifacts[].sha256` advertises: the two must agree by construction, not by
    // two independent hashes that happen to match.
    const ws = { patch: 'diff b\n', patchSha256: `sha256:${'a'.repeat(64)}` };
    expect(pickArtifact({ workspace: ws }, 'patch')?.sha256).toBe(`sha256:${'a'.repeat(64)}`);
    expect(projectLeafResult({ workspace: ws }, 2048).artifacts).toEqual([
      { kind: 'patch', bytes: 7, sha256: `sha256:${'a'.repeat(64)}` },
    ]);
    // A record that recorded none says so, and the route hashes instead.
    expect(pickArtifact({ patch: 'diff a\n' }, 'patch')?.sha256).toBeUndefined();
  });

  it('serves the assistant s reply whole, which the status body only summarises', () => {
    const reply = 'x'.repeat(5000);
    expect(pickArtifact({ status: 'responded', text: reply }, 'text')).toEqual({
      bytes: Buffer.from(reply, 'utf8'),
      contentType: 'text/plain; charset=utf-8',
    });
    // No stored digest for a reply: the route hashes these bytes for the ETag instead.
    expect(pickArtifact({ text: 'hi' }, 'text')?.sha256).toBeUndefined();
  });

  it('has nothing for an unknown kind, an empty patch, an empty text, or a refused capture', () => {
    expect(pickArtifact({ patch: 'diff a\n' }, 'transcript')).toBeNull();
    expect(pickArtifact({ patch: null, text: 'hello' }, 'patch')).toBeNull();
    expect(pickArtifact({ workspace: { patchRefused: 'too_large' } }, 'patch')).toBeNull();
    expect(pickArtifact({ patch: 'diff a\n', text: null }, 'text')).toBeNull();
    expect(pickArtifact({ text: '' }, 'text')).toBeNull();
  });
});

describe('clip (#390)', () => {
  it('leaves a string under the cap alone', () => {
    expect(clip('short', 16)).toBe('short');
  });

  it('counts BYTES, not characters, and never emits a half character', () => {
    // 'é' is two bytes, so a 3-byte cap lands mid-codepoint on the second one. The replacement
    // char is the honest answer; invalid UTF-8 on the wire is not.
    expect(clip('éé', 4)).toBe('éé');
    expect(clip('ééé', 3)).toBe('é�…[truncated]');
  });

  it('clips to nothing at a cap of 0, which is what an operator asking for no summary means', () => {
    expect(clip('anything', 0)).toBe('…[truncated]');
  });
});
