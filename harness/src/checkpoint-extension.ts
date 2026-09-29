import type { ExtensionFactory, FileEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import type { LogStore } from '@moca/session-backend';

/**
 * On each native compaction, append a tiny resume-pointer marker recording the log
 * position of the compaction's firstKeptEntryId. The marker is written through the
 * SessionManager (not the store directly) so it flows through the buffered backend
 * and the existing flush path, keeping positions consistent with Pi's append order.
 */
export function checkpointExtension(
  store: LogStore<FileEntry>,
  sm: SessionManager,
): ExtensionFactory {
  return (pi) => {
    pi.on('session_compact', async (e) => {
      const firstKeptEntryId = (e as { compactionEntry?: { firstKeptEntryId?: string } })
        .compactionEntry?.firstKeptEntryId;
      if (!firstKeptEntryId) return;
      const pos = await store.positionOfId(sm.getSessionId(), firstKeptEntryId);
      if (pos != null) {
        sm.appendCustomEntry('checkpoint', { resumeFromPosition: pos });
      }
    });
  };
}
