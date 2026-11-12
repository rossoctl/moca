import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import type { ControlPlaneApi, SessionSummary } from '../../api/types.js';
import { describeError } from '../../core/messages.js';
import { sanitizeRemote } from '../../core/sanitize.js';
import type { TranscriptStore } from '../../core/transcripts.js';
import { useTheme } from '../../theme/context.js';
import { Confirm } from '../Confirm.js';
import { Form } from '../Form.js';
import { formatRelative } from '../format.js';
import { SelectList } from '../SelectList.js';
import { Spinner } from '../Spinner.js';

/** Terminal-safe: a local title is derived from a prompt, and the id is the server's. */
export function sessionTitle(s: SessionSummary, transcripts?: TranscriptStore): string {
  const local = transcripts?.load(s.sessionId)?.title;
  if (local) return sanitizeRemote(local);
  const when = new Date(s.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  return `${when} · ${sanitizeRemote(s.sessionId).slice(0, 8)}`;
}

interface Props {
  cp: ControlPlaneApi;
  transcripts?: TranscriptStore;
  now: () => number;
  currentSessionId?: string;
  remove: (id: string) => Promise<unknown>;
  /** `configRef` is the session's bundle digest, so the status line can show it once attached. */
  onResume: (id: string, configRef?: string | null, model?: string | null) => void;
  onNew: () => void;
  onDeleted: (id: string) => void;
  onCancel: () => void;
  /**
   * Offered every control-plane error first; returning true means the host has handled it (an
   * expired login opens the Login overlay), so this overlay shows nothing of its own.
   */
  onError?: (err: unknown) => boolean;
  /**
   * Called with true while the current screen takes no input (a spinner or an error), so the
   * host can let Esc close the overlay from there; this overlay adds no key handler of its own.
   */
  onInputless?: (inputless: boolean) => void;
}

type Mode =
  | { kind: 'list' }
  | { kind: 'confirm'; id: string; title: string }
  | { kind: 'rename'; id: string; title: string };

export function SessionsOverlay({
  cp,
  transcripts,
  now,
  currentSessionId,
  remove,
  onResume,
  onNew,
  onDeleted,
  onCancel,
  onError,
  onInputless,
}: Props) {
  const { tokens: t } = useTheme();
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [reload, setReload] = useState(0);
  const fail = (err: unknown) => {
    if (!onError?.(err)) setError(describeError(err));
  };

  useEffect(() => {
    cp.listSessions({ limit: 200 })
      .then((page) => setSessions(page.sessions))
      .catch(fail);
  }, [reload]);

  const items = useMemo(
    () =>
      (sessions ?? []).map((s) => {
        const title = sessionTitle(s, transcripts);
        const detail = [
          formatRelative(s.lastTurnAt ?? s.createdAt, now()),
          `${s.turns} turn${s.turns === 1 ? '' : 's'}`,
          s.sandboxTier ? sanitizeRemote(s.sandboxTier) : undefined,
          s.sandboxTemplate ? sanitizeRemote(s.sandboxTemplate) : undefined,
          transcripts?.has(s.sessionId) ? 'local history' : undefined,
          s.sessionId === currentSessionId ? 'current' : undefined,
        ]
          .filter(Boolean)
          .join(' · ');
        return {
          key: s.sessionId,
          label: title,
          detail,
          value: { id: s.sessionId, title, configRef: s.configRef, model: s.model ?? null },
        };
      }),
    [sessions, reload, now, transcripts, currentSessionId],
  );

  const inputless = !!error || !sessions;
  useEffect(() => {
    onInputless?.(inputless);
  }, [inputless]);

  if (error) return <Text color={t.error}>{error}</Text>;
  if (!sessions) return <Spinner label="loading sessions" />;

  if (mode.kind === 'confirm') {
    return (
      <Confirm
        message={`Delete "${mode.title}"?`}
        onYes={() => {
          setMode({ kind: 'list' });
          remove(mode.id)
            .then(() => {
              onDeleted(mode.id);
              setReload((n) => n + 1);
            })
            .catch(fail);
        }}
        onNo={() => setMode({ kind: 'list' })}
      />
    );
  }

  if (mode.kind === 'rename') {
    return (
      <Form
        title="Rename session"
        fields={[{ key: 'title', label: 'Title', initial: mode.title }]}
        onCancel={() => setMode({ kind: 'list' })}
        onSubmit={(v) => {
          transcripts?.rename(mode.id, v.title.trim());
          setMode({ kind: 'list' });
          setReload((n) => n + 1);
        }}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <SelectList
        title="Sessions"
        items={items}
        filter="slash"
        emptyText="no sessions yet — press n to start one"
        onSelect={(v) => onResume(v.id, v.configRef, v.model)}
        onCancel={onCancel}
        keys={{
          n: () => onNew(),
          d: (v) => v && setMode({ kind: 'confirm', ...v }),
          r: (v) => v && setMode({ kind: 'rename', ...v }),
        }}
      />
      <Text color={t.muted}>enter resume · n new · r rename · d delete · / filter · esc close</Text>
    </Box>
  );
}
