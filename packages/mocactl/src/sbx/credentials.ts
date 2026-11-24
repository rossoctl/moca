import { ApiError } from '../api/errors.js';
import type { CredentialBinding, PutCredentialRequest } from '../api/types.js';
import { CREDENTIAL_NAME, descriptionProblem, secretFromStdin } from '../core/credential-checks.js';
import { sanitizeRemote } from '../core/sanitize.js';
import { cmdCredentialDelete, cmdCredentials } from '../headless.js';
import { SBX_EXIT, failed, type SbxCtx } from './commands.js';
import { PRESETS } from './presets.js';

interface PresetCredential {
  /** '' for the first; appended as NAME-<suffix> otherwise. */
  suffix: string;
  /** A kind of the control plane's registry. */
  kind: string;
  /** host[:port][/prefix], as the control plane parses them. */
  destinations: string[];
  binding?: CredentialBinding | CredentialBinding[];
  /** Secret fields the preset fills in. */
  fixed: Record<string, string>;
  /** The one field read from stdin. */
  stdinField: string;
}

export interface Preset {
  id: string;
  description: string;
  hint: string;
  credentials: PresetCredential[];
}

export const NOT_OFFERED =
  'this sandbox service does not offer egress credentials (ask its operator to enable SBX_EGRESS_CREDENTIALS)';

export function presetById(id: string, catalog: readonly Preset[] = PRESETS): Preset | undefined {
  return catalog.find((p) => p.id === id);
}

/** The credentials a preset writes, in order: `NAME`, then `NAME-<suffix>`. */
export function expandPreset(
  preset: Preset,
  name: string,
  stdinValue: string,
): { name: string; req: PutCredentialRequest }[] {
  if (new Set(preset.credentials.map((c) => c.stdinField)).size > 1) {
    throw new Error(
      `preset "${preset.id}" mixes stdin fields; every credential in a preset must share one stdinField`,
    );
  }
  return preset.credentials.map((c) => ({
    name: c.suffix ? `${name}-${c.suffix}` : name,
    req: {
      kind: c.kind,
      consumer: 'sandbox-egress',
      destination: { hosts: [...c.destinations] },
      ...(c.binding !== undefined ? { binding: c.binding } : {}),
      secret: { ...c.fixed, [c.stdinField]: stdinValue },
    },
  }));
}

/**
 * One failure of a credentials route, in `mocactl sbx`'s words. The unmounted route (egress off)
 * and a destination held elsewhere are the user's to act on (exit 2); the rest is `failed`'s.
 */
function credentialFailure(c: SbxCtx, err: unknown): number {
  if (err instanceof ApiError && err.status === 404 && err.code === 'not_found') {
    c.io.err(`sbx: ${NOT_OFFERED}`);
    return SBX_EXIT.usage;
  }
  if (err instanceof ApiError && err.status === 409 && err.code === 'destination_conflict') {
    c.io.err(`sbx: ${sanitizeRemote(err.message)}`);
    return SBX_EXIT.usage;
  }
  return failed(c, err);
}

export interface AddOptions {
  name: string;
  preset?: string;
  hosts: string[];
  kind?: string;
  /** The secret comes only from stdin, never argv. */
  readStdin: () => Promise<string>;
  stdinIsTTY: boolean;
}

/** What is wrong with the arguments, before stdin is read or a request made. */
export function addProblem(
  o: AddOptions,
  catalog: readonly Preset[] = PRESETS,
): string | undefined {
  if (!CREDENTIAL_NAME.test(o.name))
    return 'name: lower-case letters, digits and dashes, 1-40 characters';
  if (o.preset !== undefined) {
    if (o.hosts.length > 0 || o.kind !== undefined) {
      return '--preset fixes the hosts and the kind: do not pass --host or --kind with it';
    }
    const p = presetById(o.preset, catalog);
    if (!p) {
      return `unknown preset '${sanitizeRemote(o.preset)}'; known: ${catalog.map((x) => x.id).join(', ')}`;
    }
    const long = p.credentials
      .map((c) => (c.suffix ? `${o.name}-${c.suffix}` : o.name))
      .find((n) => !CREDENTIAL_NAME.test(n));
    return long
      ? `name: ${long} would be longer than 40 characters; use a shorter name`
      : undefined;
  }
  if (o.hosts.length === 0)
    return 'credentials add needs --host DEST (host[:port][/prefix]) or --preset ID';
  return descriptionProblem({
    name: o.name,
    kind: o.kind ?? 'bearer',
    consumer: 'sandbox-egress',
    hosts: o.hosts.join(','),
  });
}

/** `mocactl sbx credentials add`. Returns the exit code. */
export async function addCredential(
  c: SbxCtx,
  o: AddOptions,
  catalog: readonly Preset[] = PRESETS,
): Promise<number> {
  const bad = addProblem(o, catalog);
  if (bad) {
    c.io.err(`sbx: ${bad}`);
    return SBX_EXIT.usage;
  }
  if (o.stdinIsTTY) {
    c.io.err(
      'sbx: pipe the secret on stdin, e.g. `printf %s "$TOKEN" | mocactl sbx credentials add …`',
    );
    return SBX_EXIT.usage;
  }
  const preset = o.preset !== undefined ? presetById(o.preset, catalog) : undefined;
  c.io.err('reading the secret from stdin…');
  let text: string;
  try {
    text = await o.readStdin();
  } catch (err) {
    return failed(c, err);
  }
  let writes: { name: string; req: PutCredentialRequest }[];
  if (preset) {
    // One stdin, one value: each credential reads it as its own stdinField.
    const read = secretFromStdin(
      preset.credentials[0]!.kind,
      text,
      preset.credentials[0]!.stdinField,
    );
    if ('problem' in read) {
      c.io.err(`sbx: ${read.problem}`);
      return SBX_EXIT.usage;
    }
    writes = expandPreset(preset, o.name, Object.values(read.secret)[0]!);
  } else {
    const kind = o.kind ?? 'bearer';
    const read = secretFromStdin(kind, text);
    if ('problem' in read) {
      c.io.err(`sbx: ${read.problem}`);
      return SBX_EXIT.usage;
    }
    writes = [
      {
        name: o.name,
        req: {
          kind,
          consumer: 'sandbox-egress',
          destination: { hosts: o.hosts },
          secret: read.secret,
        },
      },
    ];
  }
  const stored: { name: string; hosts: string[] }[] = [];
  for (const w of writes) {
    try {
      await c.api.putCredential(w.name, w.req);
    } catch (err) {
      const code = credentialFailure(c, err);
      if (stored.length > 0) {
        c.io.err(
          `sbx: stored ${stored.map((s) => sanitizeRemote(s.name)).join(', ')}, but not ${sanitizeRemote(w.name)}; ` +
            'nothing is rolled back: fix the cause and re-run the same command',
        );
      }
      return code;
    }
    stored.push({ name: w.name, hosts: w.req.destination.hosts });
    c.io.err(
      `stored credential ${sanitizeRemote(w.name)} for ${w.req.destination.hosts.map(sanitizeRemote).join(', ')}`,
    );
  }
  if (c.json) {
    c.io.out(
      JSON.stringify({ credentials: stored.map((s) => ({ ...s, status: 'stored' })) }) + '\n',
    );
  }
  if (preset) c.io.err(preset.hint);
  return SBX_EXIT.ok;
}

/** `mocactl sbx credentials presets`: local, no login, no stdin. */
export function listPresets(
  c: Pick<SbxCtx, 'io' | 'json'>,
  catalog: readonly Preset[] = PRESETS,
): number {
  const rows = catalog.map((p) => ({
    id: p.id,
    description: p.description,
    destinations: p.credentials.flatMap((x) => x.destinations),
  }));
  if (c.json) {
    c.io.out(JSON.stringify({ presets: rows }) + '\n');
    return SBX_EXIT.ok;
  }
  const w = Math.max(...rows.map((r) => r.id.length));
  for (const r of rows) {
    c.io.out(`${r.id.padEnd(w)}  ${r.description}  (${r.destinations.join(', ')})\n`);
  }
  return SBX_EXIT.ok;
}

/** `mocactl sbx credentials ls` and `delete NAME`: the MOCA commands on the sandbox login. */
export const listCredentials = (c: SbxCtx): Promise<number> =>
  cmdCredentials(c.rt, c.io, {
    json: c.json,
    signal: c.signal,
    readiness: 'cp',
    onError: (err) => credentialFailure(c, err),
  });

export const deleteCredential = (c: SbxCtx, name: string): Promise<number> =>
  cmdCredentialDelete(c.rt, c.io, {
    name,
    json: c.json,
    signal: c.signal,
    readiness: 'cp',
    onError: (err) => credentialFailure(c, err),
  });
