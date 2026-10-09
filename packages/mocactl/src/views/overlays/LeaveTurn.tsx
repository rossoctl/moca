import { Text, useInput } from 'ink';
import { useTheme } from '../../theme/context.js';

/** Quit or switch with a detachable turn running (turn-reattach spec §6.3). */
export function LeaveTurnOverlay({
  onKeep,
  onCancel,
  onStay,
}: {
  onKeep: () => void;
  onCancel: () => void;
  onStay: () => void;
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
    <Text color={t.text}>
      <Text bold color={t.primary}>
        a turn is running
      </Text>{' '}
      — k keep it running in the background · c cancel it · esc stay
    </Text>
  );
}
