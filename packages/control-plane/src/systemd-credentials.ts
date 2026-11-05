import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A secret by name: the systemd credential `$CREDENTIALS_DIRECTORY/<name>` when the unit loads one
 * (`LoadCredential=<name>:<path>`, deploy/vm/systemd/), else the environment variable of the same
 * name. MI1 §6.7 -- secrets are files, never env vars: a credential is never inherited by a child
 * and never in /proc/<pid>/environ. The fallback is what every deployment without systemd
 * credentials (compose) keeps using, unchanged.
 *
 * Both at once is refused, not ranked: a stale env line shadowing a regenerated credential (or the
 * reverse) is a mismatched exchange token or keypair, i.e. every turn refused by a healthy process.
 * An empty credential is refused for the same reason `required()` in main.ts refuses an empty env.
 */
export function credentialValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const fromEnv = env[name] || undefined;
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir) return fromEnv;
  const path = join(dir, name);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fromEnv;
    throw new Error(`${name}: cannot read systemd credential ${path}: ${(err as Error).message}`);
  }
  // Exactly one trailing newline: what `echo`, an editor or setup-vm.sh's printf leaves.
  const value = raw.endsWith('\r\n')
    ? raw.slice(0, -2)
    : raw.endsWith('\n')
      ? raw.slice(0, -1)
      : raw;
  if (!value) throw new Error(`${name}: systemd credential ${path} is empty`);
  if (fromEnv) {
    throw new Error(
      `${name} is set both in the environment and as a systemd credential (${path}); set exactly one`,
    );
  }
  return value;
}

/** A COPY of `env` with each named secret resolved by credentialValue; `env` itself is untouched. */
export function withCredentials(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of names) {
    const v = credentialValue(env, name);
    if (v === undefined) delete out[name];
    else out[name] = v;
  }
  return out;
}
