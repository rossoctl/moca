import type { FileEntry, SessionStorageBackend } from '@earendil-works/pi-coding-agent';
import type { LogStore } from '@moca/session-backend';

/**
 * Write-behind decorator adapting a generic LogStore to Pi's SessionStorageBackend.
 *
 * append() enqueues and returns immediately (fire-and-forget) so Pi's synchronous
 * _persist path is never blocked. A serial promise chain drains writes to the inner
 * store in append order. The harness calls flush() at turn_end / session_shutdown to
 * make completed turns durable; flush() also surfaces any deferred write error.
 */
export class BufferedRedisBackend implements SessionStorageBackend {
  private queue: Promise<unknown> = Promise.resolve();
  private lastError: unknown = null;

  constructor(private readonly store: LogStore<FileEntry>) {}

  append(sessionId: string, entry: FileEntry): Promise<void> {
    const piType = entry.type;
    this.queue = this.queue
      .then(() => this.store.append(sessionId, entry, piType))
      .catch((err) => {
        this.lastError = err;
      });
    return Promise.resolve();
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.lastError) {
      const err = this.lastError;
      this.lastError = null;
      throw err;
    }
  }

  async read(sessionId: string, fromPosition?: number): Promise<FileEntry[]> {
    const rows = await this.store.read(sessionId, fromPosition);
    return rows.map((r) => r.entry);
  }

  async latestCheckpoint(sessionId: string): Promise<FileEntry | null> {
    const row = await this.store.latestWhere(
      sessionId,
      (e) => e.type === 'custom' && (e as { customType?: string }).customType === 'checkpoint',
    );
    return row ? row.entry : null;
  }

  async list(): Promise<string[]> {
    return this.store.list();
  }
}
