import { Box, Static } from 'ink';
import type { ReactNode } from 'react';
import type { BannerInfo } from '../core/banner.js';
import { splitStatic, type Block, type BlockState } from '../render/blocks.js';
import { Banner } from './Banner.js';
import { BlockView } from './BlockView.js';
import { InputBox } from './InputBox.js';
import { StatusLine } from './StatusLine.js';
import type { StatusField } from './status.js';

interface Props {
  blocks: BlockState;
  details: boolean;
  thinking: boolean;
  width: number;
  staticKey: number;
  statusFields: StatusField[];
  inputActive: boolean;
  history: string[];
  onSubmit: (text: string) => void;
  onHelp: () => void;
  prefill?: { text: string; nonce: number };
  overlay?: ReactNode;
  /** Collected at startup; printed as the FIRST <Static> item, so it scrolls away with history. */
  banner?: BannerInfo;
}

// Settled blocks are printed once through <Static> and never re-rendered, so a long transcript
// costs no more per token than a short one (spec §6.1).
export function Chat({
  blocks,
  details,
  thinking,
  width,
  staticKey,
  statusFields,
  inputActive,
  history,
  onSubmit,
  onHelp,
  prefill,
  overlay,
  banner,
}: Props) {
  const { settled, live } = splitStatic(blocks.blocks);
  // Ink's <Static> prints append-only, so the banner rides in as the first item rather than
  // around the region; it arrives after mount once the remote versions have been collected.
  const items: Array<{ banner: BannerInfo } | Block> = banner ? [{ banner }, ...settled] : settled;
  const view = (item: { banner: BannerInfo } | Block) =>
    'banner' in item ? (
      <Banner key="banner" info={item.banner} />
    ) : (
      <BlockView key={item.id} block={item} details={details} thinking={thinking} width={width} />
    );
  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={items}>
        {view}
      </Static>
      {live.map((b) => (
        <BlockView key={b.id} block={b} details={details} thinking={thinking} width={width} />
      ))}
      {overlay ? (
        <Box marginTop={1} flexDirection="column">
          {overlay}
        </Box>
      ) : null}
      <InputBox
        active={inputActive}
        history={history}
        onSubmit={onSubmit}
        onHelp={onHelp}
        prefill={prefill}
      />
      <StatusLine fields={statusFields} width={width} />
    </Box>
  );
}
