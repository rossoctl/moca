import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/redact-url.js';

// This is the only redactor: work-queue takes an injected client built with this package's
// resilientClientOptions rather than keeping its own copy.
const CASES = JSON.parse(
  readFileSync(new URL('./fixtures/redact-url-cases.json', import.meta.url), 'utf8'),
) as { why: string; in: string; out: string }[];

describe('redactUrl', () => {
  it('has cases to run (a guard against an empty or unread fixture)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(6);
  });
  for (const c of CASES) {
    it(c.why, () => {
      expect(redactUrl(c.in)).toBe(c.out);
    });
  }
});
