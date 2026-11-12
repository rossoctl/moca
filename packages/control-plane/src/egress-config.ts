import { keksFromBase64 } from './envelope.js';
import type { SandboxTemplate } from './sandbox-config.js';
import { credentialValue } from './systemd-credentials.js';

/**
 * One KVM host's egress proxy (SBX0.2b spec §4.3): the workers it serves and the bearer token the
 * host presents to the control plane's egress-credential route.
 */
export interface EgressHost {
  id: string;
  /** Each a `SandboxTemplate.worker` of this deployment. */
  workers: string[];
  /** `SH_EGRESS_TOKEN_<ID>`: 64 hex characters. */
  token: string;
}

export interface EgressConfig {
  hosts: EgressHost[];
  /** `SH_EGRESS_CREDENTIAL_TTL_SECONDS`: default 60, 5..300. */
  ttlSeconds: number;
}

const HOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const DEFAULT_TTL_S = 60;
const MIN_TTL_S = 5;
const MAX_TTL_S = 300;

/** 'kvm-1' -> 'SH_EGRESS_TOKEN_KVM_1'. */
export function egressTokenEnvName(hostId: string): string {
  return `SH_EGRESS_TOKEN_${hostId.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Egress credentials are on iff `SH_EGRESS_HOSTS` and `SH_CREDENTIAL_KEK` are both set. Every refusal
 * is at boot and names the variable, never a token value. `env` holds the KEK already resolved
 * (main.ts withCredentials); the per-host tokens have dynamic names, so they are read here.
 * `kekIsShared`: on the combined profile the KEK is the harness credential store's and always set
 * (combined control plane spec §3.5), so there egress is on iff `SH_EGRESS_HOSTS` is.
 */
export function egressConfigFromEnv(
  env: NodeJS.ProcessEnv,
  templates: SandboxTemplate[],
  opts: { kekIsShared?: boolean } = {},
): EgressConfig | undefined {
  const rawHosts = env.SH_EGRESS_HOSTS || undefined;
  const kek = env.SH_CREDENTIAL_KEK || undefined;
  if (rawHosts === undefined && (kek === undefined || opts.kekIsShared)) return undefined;
  if (rawHosts === undefined || kek === undefined) {
    throw new Error(
      'SH_EGRESS_HOSTS and SH_CREDENTIAL_KEK go together (egress credentials, SBX0.2b): set both or neither',
    );
  }
  keksFromBase64(kek);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawHosts);
  } catch {
    throw new Error('SH_EGRESS_HOSTS is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('SH_EGRESS_HOSTS must list at least one host');
  }
  const known = new Set(templates.map((t) => t.worker));
  const ids = new Set<string>();
  const claimed = new Set<string>();
  const tokenOwner = new Map<string, string>(); // token -> the host variable that holds it
  const hosts = parsed.map((h: unknown, i): EgressHost => {
    const where = `SH_EGRESS_HOSTS[${i}]`;
    const o = (typeof h === 'object' && h !== null ? h : {}) as Record<string, unknown>;
    if (typeof o.id !== 'string' || !HOST_ID_RE.test(o.id)) {
      throw new Error(`${where}: id must match ${HOST_ID_RE}`);
    }
    if (ids.has(o.id)) throw new Error(`${where}: host id '${o.id}' is listed twice`);
    ids.add(o.id);
    if (
      !Array.isArray(o.workers) ||
      o.workers.length === 0 ||
      !o.workers.every((w) => typeof w === 'string')
    ) {
      throw new Error(`${where}: workers must be a non-empty list of strings`);
    }
    for (const w of o.workers as string[]) {
      if (!known.has(w)) {
        throw new Error(`${where}: worker '${w}' is not a SH_SANDBOX_TEMPLATES worker`);
      }
      if (claimed.has(w)) throw new Error(`${where}: worker '${w}' is listed under two hosts`);
      claimed.add(w);
    }
    const name = egressTokenEnvName(o.id);
    const token = credentialValue(env, name);
    if (token === undefined || !TOKEN_RE.test(token)) {
      throw new Error(`${name} is required and must be 64 lowercase hex characters`);
    }
    const other = tokenOwner.get(token);
    if (other !== undefined) {
      throw new Error(`${other} and ${name} hold the same token: each KVM host needs its own`);
    }
    tokenOwner.set(token, name);
    return { id: o.id, workers: o.workers as string[], token };
  });

  let ttlSeconds = DEFAULT_TTL_S;
  const rawTtl = env.SH_EGRESS_CREDENTIAL_TTL_SECONDS;
  if (rawTtl !== undefined && rawTtl !== '') {
    ttlSeconds = /^[0-9]+$/.test(rawTtl) ? Number(rawTtl) : NaN;
    if (!(ttlSeconds >= MIN_TTL_S && ttlSeconds <= MAX_TTL_S)) {
      throw new Error(
        `SH_EGRESS_CREDENTIAL_TTL_SECONDS must be an integer from ${MIN_TTL_S} to ${MAX_TTL_S}`,
      );
    }
  }
  return { hosts, ttlSeconds };
}
