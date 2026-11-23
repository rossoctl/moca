import { describe, expect, it } from 'vitest';
import { parseDestination } from '../src/egress-destination.js';
import { allowsUrl, parseNotifyConfig, renderNotification } from '../src/notify-config.js';
import type { TurnEvent } from '../src/turn-record.js';
import { codeOf } from './helpers/deps.js';

const allow = ['hooks.example.com/moca', 'ntfy.example.com'].map(parseDestination);
const webhook = { kind: 'webhook', url: 'https://hooks.example.com/moca' };
const ntfy = { kind: 'ntfy', url: 'https://ntfy.example.com', topic: 'moca-alice' };

const ev = (over: Partial<TurnEvent> = {}): TurnEvent => ({
  cursor: '1-0',
  ts: 1_000,
  sessionId: 's1',
  turnId: 't1',
  state: 'responded',
  attempts: 1,
  ...over,
});

describe('allowsUrl', () => {
  it('matches host, port and path prefix', () => {
    expect(allowsUrl('https://hooks.example.com/moca', allow)).toBe(true);
    expect(allowsUrl('https://hooks.example.com/moca/deep', allow)).toBe(true);
    // A prefix match must respect segment boundaries, or /moca also allows /mocahijack.
    expect(allowsUrl('https://hooks.example.com/mocahijack', allow)).toBe(false);
    expect(allowsUrl('https://hooks.example.com/other', allow)).toBe(false);
    expect(allowsUrl('https://other.example.com/moca', allow)).toBe(false);
    // The '/' prefix allows any path on that host.
    expect(allowsUrl('https://ntfy.example.com/anything', allow)).toBe(true);
  });

  it('refuses anything that is not plain https', () => {
    expect(allowsUrl('http://hooks.example.com/moca', allow)).toBe(false);
    expect(allowsUrl('https://user:pw@hooks.example.com/moca', allow)).toBe(false);
    expect(allowsUrl('https://hooks.example.com:8443/moca', allow)).toBe(false);
    expect(allowsUrl('not a url', allow)).toBe(false);
    // The SSRF target this allowlist exists for.
    expect(allowsUrl('https://169.254.169.254/latest/meta-data', allow)).toBe(false);
  });
});

describe('parseNotifyConfig', () => {
  it('accepts one sink of each kind and defaults the states', () => {
    const { config, ntfyToken } = parseNotifyConfig(
      { sinks: [webhook, { ...ntfy, token: 'tk_1' }] },
      allow,
    );
    expect(config.sinks).toEqual([webhook, ntfy]); // the token is NOT kept on the sink
    // `lost` is a default, not merely allowed: it is the one state that leaves no other trace.
    expect(config.states).toEqual(['paused', 'failed', 'lost']);
    expect(ntfyToken).toBe('tk_1');
  });

  it('refuses every shape the sweep could not act on', async () => {
    expect(await codeOf(() => parseNotifyConfig({ sinks: [webhook] }, []))).toBe('invalid_request');
    expect(await codeOf(() => parseNotifyConfig({}, allow))).toBe('invalid_request');
    expect(await codeOf(() => parseNotifyConfig({ sinks: [] }, allow))).toBe('invalid_request');
    expect(await codeOf(() => parseNotifyConfig({ sinks: [webhook, webhook] }, allow))).toBe(
      'invalid_request',
    );
    expect(
      await codeOf(() => parseNotifyConfig({ sinks: [{ ...webhook, topic: 't' }] }, allow)),
    ).toBe('invalid_request');
    expect(
      await codeOf(() => parseNotifyConfig({ sinks: [{ kind: 'ntfy', url: ntfy.url }] }, allow)),
    ).toBe('invalid_request');
    expect(
      await codeOf(() => parseNotifyConfig({ sinks: [{ ...webhook, token: 'tk' }] }, allow)),
    ).toBe('invalid_request');
    expect(
      await codeOf(() => parseNotifyConfig({ sinks: [webhook], states: ['running'] }, allow)),
    ).toBe('invalid_request');
    expect(
      await codeOf(() => parseNotifyConfig({ sinks: [webhook], states: ['nope'] }, allow)),
    ).toBe('invalid_request');
    expect(await codeOf(() => parseNotifyConfig({ sinks: [webhook], states: [] }, allow))).toBe(
      'invalid_request',
    );
  });

  it('names MOCA_NOTIFY_ALLOW when the deployment has not enabled notifications', async () => {
    try {
      parseNotifyConfig({ sinks: [webhook] }, []);
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).toContain('MOCA_NOTIFY_ALLOW');
    }
  });

  it('refuses an explicitly-empty ntfy token, naming DELETE as the way to clear one', async () => {
    try {
      parseNotifyConfig({ sinks: [{ ...ntfy, token: '' }] }, allow);
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).toContain('DELETE /v1/notifications');
    }
    // An absent token is unaffected: that is "leave the stored one alone", not "clear it".
    const { ntfyToken } = parseNotifyConfig({ sinks: [ntfy] }, allow);
    expect(ntfyToken).toBeUndefined();
  });

  it('echoes only the hostname of a rejected sink url, never the raw value', async () => {
    try {
      parseNotifyConfig({ sinks: [{ ...webhook, url: 'https://u:hunter2@evil.test/x' }] }, allow);
      throw new Error('expected a throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('evil.test');
      expect(msg).not.toContain('hunter2');
    }
  });

  it('dedupes states and keeps TURN_STATES order', () => {
    const { config } = parseNotifyConfig(
      { sinks: [webhook], states: ['failed', 'paused', 'failed'] },
      allow,
    );
    expect(config.states).toEqual(['paused', 'failed']);
  });
});

describe('renderNotification', () => {
  it('renders one paused event with its gate summary and a deep link', () => {
    const r = renderNotification(
      [ev({ state: 'paused', gate: 'bump lodash to 4.17.21 in 14 packages?' })],
      'https://moca.example.com',
    );
    expect(r.title).toBe('moca: turn paused');
    expect(r.message).toBe('bump lodash to 4.17.21 in 14 packages?');
    expect(r.priority).toBe(4);
    expect(r.approveUrl).toBe('https://moca.example.com/approve?session=s1&turn=t1');
  });

  it('renders one failed event with its reason and no link', () => {
    const r = renderNotification([ev({ state: 'failed', reason: 'budget' })], 'https://m.example');
    expect(r.title).toBe('moca: turn failed');
    expect(r.message).toContain('budget');
    expect(r.priority).toBe(3);
    expect(r.approveUrl).toBeUndefined();
  });

  it('coalesces a batch into counts, leading with the paused gate', () => {
    const r = renderNotification(
      [
        ev({ state: 'solved' }),
        ev({ state: 'solved' }),
        ev({ state: 'paused', gate: 'ship it?', sessionId: 's2', turnId: 't2' }),
      ],
      'https://moca.example.com',
    );
    expect(r.title).toBe('moca: 1 paused, 2 solved');
    expect(r.message).toBe('ship it?');
    expect(r.approveUrl).toBe('https://moca.example.com/approve?session=s2&turn=t2');
  });

  it('omits the link when the deployment set no base url', () => {
    expect(renderNotification([ev({ state: 'paused', gate: 'g' })]).approveUrl).toBeUndefined();
  });

  it('clips a long gate summary, which is model output and otherwise unbounded', () => {
    // ntfy rejects a body past its message-size limit (4 KiB on ntfy.sh) and a rejected delivery
    // holds the cursor, so an unclipped summary would retry forever and mute the subject for good.
    const r = renderNotification([ev({ state: 'paused', gate: 'x'.repeat(10_000) })]);
    expect(r.message.length).toBeLessThan(1_100);
    expect(r.message.endsWith('…[truncated]')).toBe(true);
  });

  it('reads `lost` as a failure, not as a success', () => {
    // The reaper writes `lost` for a turn nobody ever picked up, with no reason. Under the old
    // green-tick default it reached the phone looking like work that finished.
    const r = renderNotification([ev({ state: 'lost' })]);
    expect(r.message).toBe('lost');
    expect(r.tags).toEqual(['x']);
  });
});
