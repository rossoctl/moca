import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, 'fixtures');

describe('fixtures', () => {
  for (const id of ['i1', 'i2', 'i3']) {
    it(`${id}.json references an existing fixture file`, () => {
      const item = JSON.parse(readFileSync(join(root, 'inputs', `${id}.json`), 'utf8'));
      expect(typeof item.item_id).toBe('string');
      expect(typeof item.pattern).toBe('string');
      expect(existsSync(join(root, 'repo', item.file))).toBe(true);
    });
  }
});
