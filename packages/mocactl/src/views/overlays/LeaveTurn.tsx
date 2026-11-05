import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../theme/context.js';

/** Quit or switch with a detachable turn running (turn-reattach spec §6.3). */
export function LeaveTurnOverlay({
  onKeep,
  onCancel,
  onStay,
  pendingPrompt,
}: {
  onKeep: () => void;
  onCancel: () => void;
  onStay: () => void;
  /**
   * A prompt of the user's own, waiting behind the turn this overlay is about, which leaving will
   * drop (#479). Named here because keeping the turn running saves the turn, not the prompt — and
   * this is the last moment the user can still choose to stay and let it go out.
   */
  pendingPrompt?: string;
}) {
  const { tokens: t } = useTheme();
  useInput((input, key) => {
    // Ctrl+C again picks keep: the choice that destroys nothing.
    if (key.ctrl && input === 'c') onKeep();
    else if (input === 'k') onKeep();
    else if (input === 'c') onCancel();
    else if (key.escape) onStay();
  });
  return (
    <Box flexDirection="column">
      <Text color={t.text}>
        <Text bold color={t.primary}>
          a turn is running
        </Text>{' '}
        — k keep it running in the background · c cancel it · esc stay
      </Text>
      {pendingPrompt ? (
        <Text color={t.warning}>your prompt is waiting for another turn — it will not be sent</Text>
      ) : null}
    </Box>
  );
}
