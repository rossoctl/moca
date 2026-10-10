import { Box, Text } from 'ink';
import type { BannerInfo } from '../core/banner.js';
import { useTheme } from '../theme/context.js';

// The logo column: every art row pads to the same width so the text lines up.
const ART = ['  ▄█▄    ', ' ▞███▙]  ', ' ▀███▀   '];

/**
 * The startup banner, printed once at the top of the transcript: the logo in the theme's red,
 * this client's version, the control plane's and the harness's, and where mocactl was launched
 * from. It scrolls away with the transcript instead of pinning to the screen.
 */
export function Banner({ info }: { info: BannerInfo }) {
  const { tokens: t } = useTheme();
  const lines = [
    `mocactl ${info.mocactlVersion}`,
    `control plane ${info.cpVersion ?? '?'}`,
    `harness ${info.harnessVersion ?? '?'}`,
  ];
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={line}>
          <Text color={t.logo}>{ART[i]}</Text>
          {line}
        </Text>
      ))}
      <Text>
        {' '.repeat(ART[0].length)}
        {info.cwd}
      </Text>
      <Text> </Text>
    </Box>
  );
}
