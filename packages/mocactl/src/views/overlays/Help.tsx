import { Box, Text, useInput } from 'ink';
import type { CommandHost } from '../../commands/builtin.js';
import type { CommandRegistry } from '../../commands/registry.js';
import { useTheme } from '../../theme/context.js';

const INPUT_KEYS =
  'enter send · alt+enter newline · ↑/↓ history · esc cancel the turn (twice: clear the queue) · ctrl+p commands · ctrl+c quit';

export function HelpOverlay({
  registry,
  host,
  onClose,
}: {
  registry: CommandRegistry<CommandHost>;
  host: CommandHost;
  onClose: () => void;
}) {
  const { tokens: t } = useTheme();
  // Any key closes Help, except Ctrl+C: that is the App's quit, which may ask first (leave-turn).
  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) onClose();
  });
  const rows = registry.help(host);
  const width = Math.max(...rows.map((r) => r.title.length));
  return (
    <Box flexDirection="column">
      <Text bold color={t.primary}>
        Help
      </Text>
      {rows.map((r) => (
        <Text key={r.title}>
          <Text color={t.text}>{r.title.padEnd(width + 2)}</Text>
          <Text color={t.accent}>{r.slash.padEnd(22)}</Text>
          <Text color={t.muted}>{r.keybind}</Text>
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={t.muted}>{INPUT_KEYS}</Text>
      </Box>
    </Box>
  );
}
