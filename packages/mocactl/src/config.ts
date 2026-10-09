import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { trimTrailingSlashes } from './api/url.js';

export interface Paths {
  configDir: string;
  stateDir: string;
  configFile: string;
  authFile: string;
  transcriptsDir: string;
  exportsDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv, home: string): Paths {
  const configDir = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'mocactl');
  const stateDir = join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'mocactl');
  return {
    configDir,
    stateDir,
    configFile: join(configDir, 'config.json'),
    authFile: join(configDir, 'auth.json'),
    transcriptsDir: join(stateDir, 'transcripts'),
    exportsDir: join(stateDir, 'exports'),
  };
}

export interface Preset {
  name: string;
  values: Record<string, string>;
}

export interface TuiConfig {
  controlPlaneUrl?: string;
  harnessUrl?: string;
  theme: 'system' | 'dark';
  details: boolean;
  thinking: boolean;
  reducedMotion: boolean;
  bell: boolean;
  keybinds: Record<string, string>;
  presets: Preset[];
  lastUsed: Record<string, string>;
}

export const DEFAULT_CONFIG: TuiConfig = {
  theme: 'system',
  details: false,
  thinking: true,
  reducedMotion: false,
  bell: true,
  keybinds: {},
  presets: [],
  lastUsed: {},
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isStringRecord = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every((x) => typeof x === 'string');
const isPreset = (v: unknown): v is Preset =>
  isRecord(v) && typeof v.name === 'string' && isStringRecord(v.values);

// A hand-edited file can hold anything: each field of the wrong type falls back to its default.
const FIELD_CHECKS: Record<keyof TuiConfig, (v: unknown) => boolean> = {
  controlPlaneUrl: (v) => typeof v === 'string',
  harnessUrl: (v) => typeof v === 'string',
  theme: (v) => v === 'system' || v === 'dark',
  details: (v) => typeof v === 'boolean',
  thinking: (v) => typeof v === 'boolean',
  reducedMotion: (v) => typeof v === 'boolean',
  bell: (v) => typeof v === 'boolean',
  keybinds: isStringRecord,
  presets: (v) => Array.isArray(v) && v.every(isPreset),
  lastUsed: isStringRecord,
};

function validateConfig(raw: Record<string, unknown>): { config: TuiConfig; ignored: string[] } {
  // Keys this version does not know are kept, as before, so saving does not drop them.
  const config: Record<string, unknown> = { ...DEFAULT_CONFIG, ...raw };
  const ignored: string[] = [];
  for (const [key, check] of Object.entries(FIELD_CHECKS)) {
    if (!(key in raw) || check(raw[key])) continue;
    config[key] = DEFAULT_CONFIG[key as keyof TuiConfig];
    ignored.push(key);
  }
  return { config: config as unknown as TuiConfig, ignored };
}

export function loadConfig(paths: Paths): { config: TuiConfig; exists: boolean; warning?: string } {
  if (!existsSync(paths.configFile)) return { config: { ...DEFAULT_CONFIG }, exists: false };
  try {
    const raw: unknown = JSON.parse(readFileSync(paths.configFile, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a JSON object');
    const { config, ignored } = validateConfig(raw as Record<string, unknown>);
    return ignored.length > 0
      ? {
          config,
          exists: true,
          warning: `ignoring invalid ${ignored.join(', ')} in ${paths.configFile}`,
        }
      : { config, exists: true };
  } catch (err) {
    return {
      config: { ...DEFAULT_CONFIG },
      exists: true,
      warning: `ignoring unreadable ${paths.configFile}: ${(err as Error).message}`,
    };
  }
}

// Write-then-rename so a crash never leaves a half-written file. The chmods are not about the umask
// (it can only clear bits, so a create mode is already an upper bound): `mkdir -p` leaves an
// existing directory's mode alone, and the predictable `<path>.<pid>.tmp` can be a leftover from a
// crashed run, which writeFileSync opens without applying `mode`.
function writePrivate(path: string, dir: string, data: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function saveConfig(paths: Paths, config: TuiConfig): void {
  writePrivate(paths.configFile, paths.configDir, JSON.stringify(config, null, 2) + '\n');
}

export interface CachedAuth {
  apiToken: string;
  subject: string;
  displayName?: string;
  roles: string[];
  expiresAt: number;
  controlPlaneUrl: string;
  /** Single-use; replaced on every refresh, and written BEFORE the new API token is used (B14). */
  refreshToken?: string;
  /** Epoch seconds: when this login ends however often it is refreshed. */
  refreshExpiresAt?: number;
}

export function loadAuth(paths: Paths, controlPlaneUrl: string): CachedAuth | null {
  try {
    const auth = JSON.parse(readFileSync(paths.authFile, 'utf8')) as CachedAuth;
    if (typeof auth.apiToken !== 'string' || auth.controlPlaneUrl !== controlPlaneUrl) return null;
    return auth;
  } catch {
    return null;
  }
}

export function saveAuth(paths: Paths, auth: CachedAuth): void {
  writePrivate(paths.authFile, paths.configDir, JSON.stringify(auth) + '\n');
}

export function clearAuth(paths: Paths): void {
  rmSync(paths.authFile, { force: true });
}

/** The lock two mocactl processes take before refreshing, so only one spends the refresh token. */
export function authLockPath(paths: Paths): string {
  return `${paths.authFile}.lock`;
}

export interface Endpoints {
  controlPlaneUrl?: string;
  harnessUrl?: string;
}

export function normalizeUrl(u?: string): string | undefined {
  const t = u?.trim();
  return t ? trimTrailingSlashes(t) : undefined;
}

export function resolveEndpoints(
  flags: Endpoints,
  env: NodeJS.ProcessEnv,
  config: TuiConfig,
): Endpoints {
  return {
    controlPlaneUrl: normalizeUrl(
      flags.controlPlaneUrl || env.SH_CONTROL_PLANE_URL || config.controlPlaneUrl,
    ),
    harnessUrl: normalizeUrl(flags.harnessUrl || env.SH_HARNESS_URL || config.harnessUrl),
  };
}
