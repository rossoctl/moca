import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { isTerminal, type TurnFrame, type Usage } from '../api/frames.js';

// Spec §6.6: a display cache for resume-with-history, since no route returns a session's messages.

export interface TranscriptOwner {
  subject: string;
  controlPlaneUrl: string;
}

export type TranscriptEntry =
  | { kind: 'prompt'; text: string }
  | { kind: 'turn'; turnId: string }
  | { kind: 'frame'; frame: TurnFrame; eventId?: string };

export interface UsageTotals extends Usage {
  turns: number;
}

export interface Transcript {
  sessionId: string;
  createdAt: number;
  title?: string;
  titleSource?: 'auto' | 'user';
  entries: TranscriptEntry[];
  prompts: string[];
  usage: UsageTotals;
  /** The SSE id of the last recorded frame (`<turnId>:<entryId>`): where a re-attach resumes. */
  lastEventId?: string;
}

type Rec =
  | { kind: 'header'; v: 1; createdAt: number; subject: string; controlPlaneUrl: string }
  | { kind: 'prompt'; at: number; text: string }
  | { kind: 'turn'; at: number; turnId: string; eventId?: string }
  | { kind: 'frame'; at: number; frame: TurnFrame; eventId?: string }
  | { kind: 'title'; at: number; title: string; source: 'auto' | 'user' };

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function deriveTitle(prompt: string, max = 50): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return (space > cut.length / 2 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

const zeroUsage = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  turns: 0,
});

/** True when the file exists, is non-empty and does not end with a newline. */
function endsTorn(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

export class TranscriptStore {
  private readonly pending = new Map<
    string,
    { type: 'text' | 'thinking'; delta: string; eventId?: string }
  >();
  /** Session → the last turnId recorded, so a re-attach's repeated turn frame is written once. */
  private readonly turns = new Map<string, string>();
  private readonly titled = new Set<string>();
  private readonly ownershipCache = new Map<string, boolean>();
  private readonly tailChecked = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly owner: TranscriptOwner,
    private readonly now: () => number = Date.now,
  ) {}

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`refusing unsafe session id: ${id}`);
    return join(this.dir, `${id}.jsonl`);
  }

  private ownsFile(id: string): boolean {
    const cached = this.ownershipCache.get(id);
    if (cached !== undefined) return cached;
    const path = this.file(id);
    if (!existsSync(path)) {
      this.ownershipCache.set(id, true);
      return true;
    }
    let owns = false;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as Rec;
        if (rec.kind === 'header') {
          owns =
            rec.subject === this.owner.subject &&
            rec.controlPlaneUrl === this.owner.controlPlaneUrl;
          break;
        }
      } catch {
        continue;
      }
    }
    this.ownershipCache.set(id, owns);
    return owns;
  }

  private write(id: string, rec: Rec): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const path = this.file(id);
    // A crash mid-append (in an earlier process) can leave a torn last line with no newline;
    // appending straight after it would glue the next record onto it and lose that one too.
    const sep = this.tailChecked.has(id) ? '' : endsTorn(path) ? '\n' : '';
    this.tailChecked.add(id);
    appendFileSync(path, sep + JSON.stringify(rec) + '\n', { mode: 0o600 });
  }

  has(id: string): boolean {
    return existsSync(this.file(id));
  }

  ensure(id: string, createdAt: number = this.now()): void {
    if (!this.ownsFile(id)) return;
    if (!this.has(id)) this.write(id, { kind: 'header', v: 1, createdAt, ...this.owner });
  }

  flush(id: string): void {
    if (!this.ownsFile(id)) return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.write(id, {
      kind: 'frame',
      at: this.now(),
      frame: { type: p.type, delta: p.delta },
      ...(p.eventId ? { eventId: p.eventId } : {}),
    });
  }

  appendPrompt(id: string, text: string): void {
    if (!this.ownsFile(id)) return;
    this.ensure(id);
    this.flush(id);
    if (!this.titled.has(id)) {
      if (this.load(id)?.title === undefined) {
        this.write(id, { kind: 'title', at: this.now(), title: deriveTitle(text), source: 'auto' });
      }
      this.titled.add(id);
    }
    this.write(id, { kind: 'prompt', at: this.now(), text });
  }

  appendFrame(id: string, frame: TurnFrame, eventId?: string): void {
    if (!this.ownsFile(id)) return;
    this.ensure(id);
    if (frame.type === 'turn') {
      // A re-attach repeats the turn frame; the transcript names each turn once.
      if (this.turns.get(id) === frame.turnId) return;
      this.flush(id);
      this.turns.set(id, frame.turnId);
      this.write(id, {
        kind: 'turn',
        at: this.now(),
        turnId: frame.turnId,
        ...(eventId ? { eventId } : {}),
      });
      return;
    }
    if (frame.type === 'text' || frame.type === 'thinking') {
      const p = this.pending.get(id);
      if (p && p.type === frame.type) {
        p.delta += frame.delta;
        if (eventId) p.eventId = eventId;
        return;
      }
      this.flush(id);
      this.pending.set(id, {
        type: frame.type,
        delta: frame.delta,
        ...(eventId ? { eventId } : {}),
      });
      return;
    }
    this.flush(id);
    this.write(id, { kind: 'frame', at: this.now(), frame, ...(eventId ? { eventId } : {}) });
  }

  rename(id: string, title: string): void {
    if (!this.ownsFile(id)) return;
    this.ensure(id);
    this.titled.add(id);
    this.write(id, { kind: 'title', at: this.now(), title, source: 'user' });
  }

  delete(id: string): void {
    this.pending.delete(id);
    this.turns.delete(id);
    this.titled.delete(id);
    this.ownershipCache.delete(id);
    this.tailChecked.delete(id);
    rmSync(this.file(id), { force: true });
  }

  load(id: string): Transcript | null {
    const path = this.file(id);
    if (!existsSync(path)) return null;
    let header: Extract<Rec, { kind: 'header' }> | undefined;
    const t: Transcript = {
      sessionId: id,
      createdAt: 0,
      entries: [],
      prompts: [],
      usage: zeroUsage(),
    };
    let lastTurn: string | undefined;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec: Rec;
      try {
        rec = JSON.parse(line) as Rec;
      } catch {
        continue; // a line torn by a crash mid-append; everything before it is intact
      }
      switch (rec.kind) {
        case 'header':
          header = rec;
          t.createdAt = rec.createdAt;
          break;
        case 'title':
          t.title = rec.title;
          t.titleSource = rec.source;
          break;
        case 'prompt':
          t.entries.push({ kind: 'prompt', text: rec.text });
          t.prompts.push(rec.text);
          break;
        case 'turn':
          t.entries.push({ kind: 'turn', turnId: rec.turnId });
          if (rec.eventId) t.lastEventId = rec.eventId;
          lastTurn = rec.turnId;
          break;
        case 'frame':
          t.entries.push({
            kind: 'frame',
            frame: rec.frame,
            ...(rec.eventId ? { eventId: rec.eventId } : {}),
          });
          if (rec.eventId) t.lastEventId = rec.eventId;
          if (isTerminal(rec.frame)) {
            t.usage.turns += 1;
            const u = rec.frame.usage;
            if (u) {
              t.usage.input += u.input;
              t.usage.output += u.output;
              t.usage.cacheRead += u.cacheRead;
              t.usage.cacheWrite += u.cacheWrite;
              t.usage.total += u.total;
            }
          }
          break;
      }
    }
    if (
      header?.subject !== this.owner.subject ||
      header.controlPlaneUrl !== this.owner.controlPlaneUrl
    ) {
      return null;
    }
    // Seed the per-process dedupe, so a resumed process re-attaching names the turn once too.
    if (lastTurn) this.turns.set(id, lastTurn);
    return t;
  }
}
