import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { DeviceStart } from '../../api/types.js';
import type { CachedAuth } from '../../config.js';
import { LoginCancelledError, deviceLogin, toCachedAuth, type LoginDeps } from '../../core/auth.js';
import { describeError } from '../../core/messages.js';
import { sanitizeRemote } from '../../core/sanitize.js';
import { useTheme } from '../../theme/context.js';
import { formatDuration } from '../format.js';
import { Spinner } from '../Spinner.js';

interface Props {
  deps: LoginDeps;
  controlPlaneUrl: string;
  onLoggedIn: (auth: CachedAuth) => void;
  onCancel: () => void;
  copy?: (text: string) => void | Promise<void>;
  openUrl?: (url: string) => void;
}

export function LoginOverlay({
  deps,
  controlPlaneUrl,
  onLoggedIn,
  onCancel,
  copy,
  openUrl,
}: Props) {
  const { tokens: t } = useTheme();
  const [start, setStart] = useState<DeviceStart>();
  const [shownAt, setShownAt] = useState(0);
  const [now, setNow] = useState(deps.now());
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setError(undefined);
    setStart(undefined);
    deviceLogin(
      deps,
      (s, attempt) => {
        setStart(s);
        setShownAt(deps.now());
        // deviceLogin re-issues an expired code once (#431); say why the code on screen changed.
        setNote(attempt > 1 ? 'that code expired — here is a new one' : undefined);
      },
      ac.signal,
    )
      .then((login) => {
        // Login can resolve after this effect's own cleanup already fired (Esc cancelling,
        // unmount, or a retry starting a new attempt) — deviceLogin only rejects with
        // LoginCancelledError when the signal aborts BEFORE it settles, not when it aborts in
        // the same tick it resolves. Without this check a stale attempt could still log the
        // component in after the user has moved on.
        if (ac.signal.aborted) return;
        onLoggedIn(toCachedAuth(login, controlPlaneUrl));
      })
      .catch((err) => {
        if (!(err instanceof LoginCancelledError)) setError(describeError(err));
      });
    return () => ac.abort();
  }, [attempt]);

  useEffect(() => {
    const i = setInterval(() => setNow(deps.now()), 1000);
    return () => clearInterval(i);
  }, []);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.ctrl) return; // Ctrl+C is the App's quit, not "copy the code"
    if (error && input === 'r') return setAttempt((a) => a + 1);
    if (!start) return;
    if (input === 'c' && copy)
      void Promise.resolve(copy(sanitizeRemote(start.userCode))).then(() => setNote('code copied'));
    if (input === 'o' && openUrl) {
      // openUrl already restricts to http/https, so it gets the raw value; the sanitized form is
      // for display only.
      openUrl(start.verificationUri);
      setNote('opened in your browser');
    }
  });

  const secondsLeft = start
    ? Math.max(0, Math.ceil((shownAt + start.expiresIn * 1000 - now) / 1000))
    : 0;
  const hints = [copy && 'c copy code', openUrl && 'o open browser', 'esc cancel']
    .filter(Boolean)
    .join(' · ');

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={2}
      paddingY={1}
    >
      <Text bold>Log in with GitHub</Text>
      {error ? (
        <>
          <Text color={t.error}>{error}</Text>
          <Text color={t.muted}>r retry · esc cancel</Text>
        </>
      ) : !start ? (
        <Spinner label="contacting the control plane" />
      ) : (
        <>
          <Text>
            Open{' '}
            <Text color={t.info} underline>
              {sanitizeRemote(start.verificationUri)}
            </Text>{' '}
            and enter:
          </Text>
          <Box marginY={1}>
            <Text bold color={t.primary}>
              {'  '}
              {sanitizeRemote(start.userCode)}
            </Text>
          </Box>
          <Spinner
            label={`waiting for approval · code expires in ${formatDuration(secondsLeft * 1000)}`}
          />
          <Text color={t.muted}>{hints}</Text>
          {note ? <Text color={t.success}>{note}</Text> : null}
        </>
      )}
    </Box>
  );
}
