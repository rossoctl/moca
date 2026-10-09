import { KNOWN_FRAME_TYPES, type TurnFrame } from './frames.js';

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buf = '';
  private pendingCr = false;

  push(chunk: string): SseEvent[] {
    // A CR at the very end of a chunk may be the first half of a CRLF; hold it back so the pair is
    // not normalized into two line breaks (which would read as an event boundary).
    let s = this.pendingCr ? '\r' + chunk : chunk;
    this.pendingCr = s.endsWith('\r');
    if (this.pendingCr) s = s.slice(0, -1);
    this.buf += s.replace(/\r\n?/g, '\n');

    const out: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const ev = parseBlock(this.buf.slice(0, idx));
      this.buf = this.buf.slice(idx + 2);
      if (ev) out.push(ev);
    }
    return out;
  }

  flush(): SseEvent[] {
    const rest = this.buf + (this.pendingCr ? '\n' : '');
    this.buf = '';
    this.pendingCr = false;
    const ev = rest.trim() ? parseBlock(rest) : undefined;
    return ev ? [ev] : [];
  }

  /**
   * End of stream, per the SSE spec: a held-back CR still ends its line, so events it completes
   * are dispatched, but a block with no closing blank line is discarded, id and all.
   */
  end(): SseEvent[] {
    const out = this.pendingCr ? this.push('\n') : [];
    this.buf = '';
    this.pendingCr = false;
    return out;
  }
}

function parseBlock(block: string): SseEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  let id: string | undefined;
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  return data.length === 0
    ? undefined
    : { event, data: data.join('\n'), ...(id !== undefined ? { id } : {}) };
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    yield* parser.push(decoder.decode(chunk, { stream: true }));
  }
  yield* parser.push(decoder.decode());
  // Not flush(): a trailing block cut mid-event must not surface (its id would skip the frame on a
  // re-attach); the stream reader reports the body as truncated instead.
  yield* parser.end();
}

const KNOWN = new Set<string>(KNOWN_FRAME_TYPES);

export function toFrame(e: SseEvent): TurnFrame {
  let data: unknown;
  try {
    data = JSON.parse(e.data);
  } catch {
    return { type: 'unknown', event: e.event, data: e.data };
  }
  const type = (data as { type?: unknown } | null)?.type;
  if (KNOWN.has(e.event) && type === e.event) return data as TurnFrame;
  return { type: 'unknown', event: e.event, data };
}
