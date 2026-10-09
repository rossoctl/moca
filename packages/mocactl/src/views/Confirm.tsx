import { Text, useInput } from 'ink';
import { useTheme } from '../theme/context.js';

export function Confirm({
  message,
  onYes,
  onNo,
}: {
  message: string;
  onYes: () => void;
  onNo: () => void;
}) {
  const { tokens: t } = useTheme();
  useInput((input, key) => {
    if (key.ctrl && input === 'c') return; // the App's quit, not an answer
    if (input.toLowerCase() === 'y') onYes();
    else onNo();
  });
  return (
    <Text color={t.warning}>
      {message} <Text color={t.muted}>y to confirm · any other key to cancel</Text>
    </Text>
  );
}
