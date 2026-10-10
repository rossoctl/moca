import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BLOCKS, addUser, reduceFrame } from '../src/render/blocks.js';
import { Chat } from '../src/views/Chat.js';
import { withTheme } from './helpers/ink.js';

describe('Chat', () => {
  it('renders settled history, the live block, the input and the status line', () => {
    let s = addUser(EMPTY_BLOCKS, 'hello');
    s = reduceFrame(s, { type: 'text', delta: 'streaming now' });
    // <Static> output is written separately from the live frame, so read every frame written.
    const { frames } = render(
      withTheme(
        <Chat
          blocks={s}
          details={false}
          thinking
          width={80}
          staticKey={0}
          statusFields={[{ key: 'turn', text: 'streaming 1.0s' }]}
          inputActive
          history={[]}
          onSubmit={vi.fn()}
          onHelp={vi.fn()}
        />,
      ),
    );
    const f = frames.join('\n');
    expect(f).toContain('› hello');
    expect(f).toContain('streaming now');
    expect(f).toContain('type a message');
    expect(f).toContain('streaming 1.0s');
  });

  it('renders an overlay between the transcript and the input', () => {
    const { lastFrame } = render(
      withTheme(
        <Chat
          blocks={EMPTY_BLOCKS}
          details={false}
          thinking
          width={80}
          staticKey={0}
          statusFields={[]}
          inputActive={false}
          history={[]}
          onSubmit={vi.fn()}
          onHelp={vi.fn()}
          overlay={<Text>OVERLAY</Text>}
        />,
      ),
    );
    expect(lastFrame()).toContain('OVERLAY');
  });

  it('prints the banner above the settled history, so it scrolls away with it', () => {
    const { frames } = render(
      withTheme(
        <Chat
          blocks={addUser(EMPTY_BLOCKS, 'hello')}
          details={false}
          thinking
          width={80}
          staticKey={0}
          statusFields={[]}
          inputActive
          history={[]}
          onSubmit={vi.fn()}
          onHelp={vi.fn()}
          banner={{
            mocactlVersion: '0.5.2',
            cpVersion: '0.5.1',
            harnessVersion: '0.5.0',
            cwd: '~/w',
          }}
        />,
      ),
    );
    const f = frames.join('\n');
    expect(f).toContain('control plane 0.5.1');
    // The banner is the first thing <Static> prints, ahead of any settled block.
    expect(f.indexOf('› hello')).toBeGreaterThan(f.indexOf('control plane 0.5.1'));
  });
});
