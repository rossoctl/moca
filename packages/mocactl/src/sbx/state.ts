import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * What a sandbox id may look like on this side: `sbx-` and lowercase alphanumerics (the control
 * plane issues `sbx-` plus 26 hex, SBX0 §5.1). Checked before an id reaches a URL or a file name,
 * so a hand-edited `.sbx/sandbox.json` or argument cannot name a path.
 */
export const SANDBOX_ID_RE = /^sbx-[0-9a-z]{1,64}$/;

/**
 * The repository's bound sandbox: `.sbx/sandbox.json` in the nearest directory up from `cwd`,
 * stopping at a repository root (a `.git` entry) or `/`. `mocactl sbx up` (1c) writes it; every
 * other command reads it when no id is given (SBX0 §6.1).
 */
export function findSandboxFile(cwd: string): string | undefined {
  let dir = cwd;
  for (;;) {
    const f = join(dir, '.sbx', 'sandbox.json');
    if (existsSync(f)) return f;
    if (existsSync(join(dir, '.git'))) return undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function readBoundSandbox(cwd: string): string | undefined {
  const f = findSandboxFile(cwd);
  if (!f) return undefined;
  try {
    const id = (JSON.parse(readFileSync(f, 'utf8')) as { id?: unknown }).id;
    return typeof id === 'string' && SANDBOX_ID_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
