import { describe, expect, it } from 'vitest';
import { ApiError, TurnCancelledError } from '../src/api/errors.js';
import type { TurnFrame } from '../src/api/frames.js';
import { readFileSync } from 'node:fs';
import { CLEAN_STOP_REASONS, HarnessClient } from '../src/api/harness.js';
import { json, scriptedFetch } from './helpers/fake-fetch.js';
import { sseResponse, sseText } from './helpers/sse.js';

const done = { type: 'done', sessionId: 's1', stopReason: 'end_turn' };

async function collect(it: AsyncGenerator<TurnFrame>): Promise<TurnFrame[]> {
  const out: TurnFrame[] = [];
  for await (const f of it) out.push(f);
  return out;
}

describe('CLEAN_STOP_REASONS', () => {
  // The harness's terminalFrame and this client's sync fallback must agree on what a clean finish
  // is: the two lists drifting from pi's vocabulary is exactly how #348's `error`-on-every-turn bug
  // shipped. Read from source because mocactl takes no dependency on @moca/harness.
  it('matches the harness`s set exactly', () => {
    const src = readFileSync(
      new URL('../../../harness/src/turn-stream.ts', import.meta.url),
      'utf8',
    );
    const m = /export const CLEAN_STOP_REASONS = new Set\(\[([^\]]*)\]\)/.exec(src);
    expect(m, 'CLEAN_STOP_REASONS not found in harness/src/turn-stream.ts').not.toBeNull();
    const harness = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(harness.length).toBeGreaterThan(0);
    expect([...CLEAN_STOP_REASONS].sort()).toEqual(harness);
  });
});

describe('HarnessClient.streamTurn', () => {
  it('posts to /v1/turn with SSE accept and the session token', async () => {
    const { fetch, calls } = scriptedFetch(
      sseResponse([
        sseText([
          { type: 'text', delta: 'hi' },
          { type: 'done', sessionId: 's1', stopReason: 'end_turn' },
        ] as any[]),
      ]),
    );
    const frames = await collect(
      new HarnessClient('http://h/', fetch).streamTurn({
        sessionId: 's1',
        prompt: 'p',
        token: 'st',
      }),
    );
    expect(frames.map((f) => f.type)).toEqual(['text', 'done']);
    expect(calls[0]).toMatchObject({
      url: 'http://h/v1/turn',
      method: 'POST',
      body: { sessionId: 's1', prompt: 'p' },
    });
    expect(calls[0].headers.accept).toBe('text/event-stream');
    expect(calls[0].headers.authorization).toBe('Bearer st');
  });

  // The sync body carries executeTurn's stopReason, which is pi's normalized vocabulary ('stop',
  // 'length'), not the Anthropic wire's end_turn/max_tokens -- the same mismatch that made the
  // server's own terminalFrame end clean turns in `error` (#348).
  it.each(['stop', 'length', 'end_turn', 'max_tokens'])(
    "a sync JSON reply that stopped with '%s' ends in done",
    async (stopReason) => {
      const { fetch } = scriptedFetch(json({ sessionId: 's1', response: 'pong', stopReason }));
      const frames = await collect(
        new HarnessClient('http://h', fetch).streamTurn({
          sessionId: 's1',
          prompt: 'p',
          token: 't',
        }),
      );
      expect(frames.map((f) => f.type)).toEqual(['text', 'done']);
    },
  );

  it.each(['error', 'aborted', 'toolUse'])(
    "a sync JSON reply that stopped with '%s' ends in error",
    async (stopReason) => {
      const { fetch } = scriptedFetch(json({ sessionId: 's1', response: '', stopReason }));
      const frames = await collect(
        new HarnessClient('http://h', fetch).streamTurn({
          sessionId: 's1',
          prompt: 'p',
          token: 't',
        }),
      );
      expect(frames.at(-1)?.type).toBe('error');
    },
  );

  it('stops at the terminal frame even if more bytes follow', async () => {
    const { fetch } = scriptedFetch(
      sseResponse([
        sseText([
          { type: 'done', sessionId: 's1', stopReason: 'end_turn' },
          { type: 'text', delta: 'late' },
        ] as any[]),
      ]),
    );
    const frames = await collect(
      new HarnessClient('http://h', fetch).streamTurn({ sessionId: 's1', prompt: 'p', token: 't' }),
    );
    expect(frames).toHaveLength(1);
  });

  it('throws a typed error before any frame on a non-2xx response', async () => {
    const { fetch } = scriptedFetch(json({ error: 'saturated' }, 503, { 'retry-after': '5' }));
    const err = await collect(
      new HarnessClient('http://h', fetch).streamTurn({ sessionId: 's', prompt: 'p', token: 't' }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      source: 'harness',
      status: 503,
      code: 'saturated',
      retryAfterS: 5,
    });
  });

  it('ends with stream_truncated when the stream closes early', async () => {
    const { fetch } = scriptedFetch(
      sseResponse([sseText([{ type: 'text', delta: 'partial' }] as any[])]),
    );
    const seen: TurnFrame[] = [];
    const err = await (async () => {
      for await (const f of new HarnessClient('http://h', fetch).streamTurn({
        sessionId: 's',
        prompt: 'p',
        token: 't',
      }))
        seen.push(f);
    })().catch((e) => e);
    expect(seen).toHaveLength(1);
    expect(err).toMatchObject({ code: 'stream_truncated', status: 0, source: 'harness' });
    expect(err.message).toBe('the harness closed the stream before the turn finished');
  });

  it('synthesizes frames from a plain JSON reply', async () => {
    const { fetch } = scriptedFetch(
      json({ sessionId: 's1', response: 'hello', stopReason: 'end_turn' }),
    );
    const frames = await collect(
      new HarnessClient('http://h', fetch).streamTurn({ sessionId: 's1', prompt: 'p', token: 't' }),
    );
    expect(frames).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'done', sessionId: 's1', stopReason: 'end_turn' },
    ]);
  });

  it('throws TurnCancelledError when aborted before the response', async () => {
    const ac = new AbortController();
    ac.abort();
    const { fetch } = scriptedFetch(new DOMException('aborted', 'AbortError'));
    const err = await collect(
      new HarnessClient('http://h', fetch).streamTurn({
        sessionId: 's',
        prompt: 'p',
        token: 't',
        signal: ac.signal,
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TurnCancelledError);
  });
});

describe('HarnessClient.probeTrust', () => {
  it('reports trusted on session_mismatch, sending a mismatched id', async () => {
    const { fetch, calls } = scriptedFetch(json({ error: 'session_mismatch' }, 400));
    expect(await new HarnessClient('http://h', fetch).probeTrust('st', 's1')).toBe('trusted');
    expect(calls[0].body.sessionId).not.toBe('s1');
    expect(calls[0].headers.authorization).toBe('Bearer st');
  });

  it.each([
    [json({ error: 'token_invalid' }, 401)],
    [json({ error: 'session_not_found' }, 404)],
    [json({ sessionId: 'x', response: 'ran', stopReason: 'end_turn' }, 200)],
  ])('reports untrusted for %#', async (res) => {
    const { fetch } = scriptedFetch(res);
    expect(await new HarnessClient('http://h', fetch).probeTrust('st', 's1')).toBe('untrusted');
  });

  it('throws on an unrelated server error', async () => {
    const { fetch } = scriptedFetch(json({ error: 'internal_error' }, 500));
    await expect(
      new HarnessClient('http://h', fetch).probeTrust('st', 's1'),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('HarnessClient.health', () => {
  it('GETs /health', async () => {
    const { fetch, calls } = scriptedFetch(new Response('ok'));
    await new HarnessClient('http://h', fetch).health();
    expect(calls[0]).toMatchObject({ url: 'http://h/health', method: 'GET' });
  });

  it('reads the harness version from the X-Moca-Version response header', async () => {
    const res = new Response('ok', {
      headers: { 'content-type': 'text/plain', 'x-moca-version': 'v0.5.2' },
    });
    const { fetch } = scriptedFetch(res);
    expect(await new HarnessClient('http://h', fetch).health()).toEqual({ version: 'v0.5.2' });
  });

  it('passes an abort signal through to the fetch', async () => {
    const { fetch, calls } = scriptedFetch(new Response('ok'));
    const controller = new AbortController();
    await new HarnessClient('http://h', fetch).health({ signal: controller.signal });
    expect(calls[0].signal).toBe(controller.signal);
  });

  it.each([
    ['an old harness that sent no header', new Response('ok')],
    ['an empty header', new Response('ok', { headers: { 'x-moca-version': '' } })],
  ])('reports no version for %s', async (_label, res) => {
    const { fetch } = scriptedFetch(res);
    expect(await new HarnessClient('http://h', fetch).health()).toEqual({});
  });
});

describe('detachable turns', () => {
  const turn = { type: 'turn', turnId: 't1', sessionId: 's1' };
  const done = { type: 'done', sessionId: 's1', stopReason: 'stop' };
  const withIds = (frames: Array<{ type: string; [k: string]: unknown }>) =>
    frames.map((f, i) => `id: t1:${i + 1}-0\nevent: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);

  it('sends detachable and reports each frame id before yielding it', async () => {
    let body: any;
    const client = new HarnessClient('http://h', (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return sseResponse(withIds([turn, done]));
    }) as typeof fetch);
    const seen: string[] = [];
    const frames = [];
    for await (const f of client.streamTurn({
      sessionId: 's1',
      prompt: 'p',
      token: 'tok',
      detachable: true,
      onEventId: (id) => seen.push(`${id}<${frames.length}`),
    }))
      frames.push(f.type);
    expect(body).toEqual({ sessionId: 's1', prompt: 'p', detachable: true });
    expect(frames).toEqual(['turn', 'done']);
    expect(seen).toEqual(['t1:1-0<0', 't1:2-0<1']);
  });

  it('attach GETs /v1/turn with Last-Event-ID and yields to the terminal', async () => {
    let url = '';
    let headers: Record<string, string> = {};
    const client = new HarnessClient('http://h', (async (u: string, init: RequestInit) => {
      url = u;
      headers = init.headers as Record<string, string>;
      return sseResponse(withIds([turn, { type: 'text', delta: 'x' }, done]));
    }) as typeof fetch);
    const types = [];
    for await (const f of client.attach({ sessionId: 's1', token: 'tok', lastEventId: 't1:1-0' }))
      types.push(f.type);
    expect(url).toBe('http://h/v1/turn?sessionId=s1');
    expect(headers['last-event-id']).toBe('t1:1-0');
    expect(headers.authorization).toBe('Bearer tok');
    expect(types).toEqual(['turn', 'text', 'done']);
  });

  it('attach maps any 404 to turn_not_found, JSON or bare', async () => {
    for (const res of [
      () => Response.json({ error: 'turn_not_found' }, { status: 404 }),
      () => new Response(null, { status: 404 }),
    ]) {
      const client = new HarnessClient('http://h', (async () => res()) as typeof fetch);
      await expect(
        (async () => {
          for await (const _ of client.attach({ sessionId: 's1', token: 't' }));
        })(),
      ).rejects.toMatchObject({ code: 'turn_not_found', status: 404 });
    }
  });

  it('cancelTurn POSTs the turn id and resolves on 202', async () => {
    let req: { url: string; body: any } | undefined;
    const client = new HarnessClient('http://h', (async (u: string, init: RequestInit) => {
      req = { url: u, body: JSON.parse(String(init.body)) };
      return Response.json({ turnId: 't1' }, { status: 202 });
    }) as typeof fetch);
    expect(await client.cancelTurn({ sessionId: 's1', turnId: 't1', token: 'tok' })).toEqual({
      turnId: 't1',
    });
    expect(req).toEqual({
      url: 'http://h/v1/turn/cancel',
      body: { sessionId: 's1', turnId: 't1' },
    });
  });

  it('cancelTurn resolves with no turnId when the 202 body names none', async () => {
    for (const body of ['', 'not json', '{"turnId":7}']) {
      const client = new HarnessClient(
        'http://h',
        (async () => new Response(body, { status: 202 })) as unknown as typeof fetch,
      );
      expect(await client.cancelTurn({ sessionId: 's1', token: 't' })).toEqual({});
    }
  });

  it("cancelTurn returns the 202's outcome when it is a known one", async () => {
    const answers: [unknown, object][] = [
      [
        { turnId: 't0', outcome: 'ended' },
        { turnId: 't0', outcome: 'ended' },
      ],
      [
        { turnId: 't1', outcome: 'requested' },
        { turnId: 't1', outcome: 'requested' },
      ],
      [{ turnId: 't1', outcome: 'other' }, { turnId: 't1' }],
      [{ turnId: 't1', outcome: 3 }, { turnId: 't1' }],
    ];
    for (const [body, want] of answers) {
      const client = new HarnessClient('http://h', (async () =>
        Response.json(body, { status: 202 })) as typeof fetch);
      expect(await client.cancelTurn({ sessionId: 's1', token: 't' })).toEqual(want);
    }
  });

  it('cancelTurn reads a bare 404 (a harness without the route) as turn_not_found', async () => {
    let drained = false;
    const client = new HarnessClient('http://h', (async () => {
      const body = new ReadableStream({
        start: (c) => c.enqueue(new TextEncoder().encode('404 page not found')),
        cancel: () => void (drained = true),
      });
      return new Response(body, { status: 404 });
    }) as typeof fetch);
    await expect(client.cancelTurn({ sessionId: 's1', token: 't' })).rejects.toMatchObject({
      status: 404,
      code: 'turn_not_found',
    });
    expect(drained).toBe(true);
  });

  it('cancelTurn throws the harness error otherwise', async () => {
    const client = new HarnessClient('http://h', (async () =>
      Response.json({ error: 'turn_mismatch', turnId: 't2' }, { status: 409 })) as typeof fetch);
    await expect(client.cancelTurn({ sessionId: 's1', token: 't' })).rejects.toMatchObject({
      code: 'turn_mismatch',
    });
  });
});
