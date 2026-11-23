import { describe, expect, it } from 'vitest';
import { versionReport } from '../src/version-report.js';

describe('versionReport', () => {
  it('is empty with no control plane configured', async () => {
    expect(await versionReport([])).toEqual([]);
  });

  it('calls a control plane that does not answer in time unreachable, and aborts it', async () => {
    let aborted = false;
    const lines = await versionReport(
      [
        {
          label: 'control plane',
          url: 'http://cp',
          discovery: ({ signal }) =>
            new Promise((_, reject) =>
              signal.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('aborted'));
              }),
            ),
        },
      ],
      { timeoutMs: 10 },
    );
    expect(lines).toEqual(['control plane: unreachable (http://cp)']);
    expect(aborted).toBe(true);
  });

  it('strips control sequences from a remote version', async () => {
    const lines = await versionReport([
      {
        label: 'control plane',
        url: 'http://cp',
        discovery: async () => ({ version: 'v1\u001b]52;c;aGk=\u0007' }),
      },
    ]);
    expect(lines).toEqual(['control plane: v1 (http://cp)']);
  });
});
