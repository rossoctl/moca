import { credentialValue } from './systemd-credentials.js';

/**
 * The KVM hosts whose agents build and serve templates (template lifecycle spec §6.1): each host's
 * id and the bearer its `sbx-host-agent` presents. The agent polls; nothing on the host listens.
 *
 *   SH_TEMPLATE_HOSTS        a JSON list of {id}; absent or blank: no host routes answer (401)
 *   SH_HOST_TOKEN_<ID>       per host, 64 hex characters (the id upper-cased, `-` to `_`); from the
 *                            environment or a systemd credential, as egress tokens are
 *
 * Every refusal is at boot and names the variable, never a token value (as for SH_EGRESS_HOSTS).
 * A host token is distinct from the janitor's and from every egress token: one leaked bearer must
 * not stand in for another host's role.
 */
export interface TemplateHost {
  id: string;
  token: string;
}

const HOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** 'kvm-1' -> 'SH_HOST_TOKEN_KVM_1'. */
export function hostTokenEnvName(id: string): string {
  return `SH_HOST_TOKEN_${id.toUpperCase().replace(/-/g, '_')}`;
}

export function templateHostsFromEnv(
  env: NodeJS.ProcessEnv,
  others: string[] = [],
): TemplateHost[] {
  const raw = env.SH_TEMPLATE_HOSTS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SH_TEMPLATE_HOSTS is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('SH_TEMPLATE_HOSTS must be a JSON list of {id}');
  const seen = new Set<string>();
  const tokens = new Set(others);
  return parsed.map((h: unknown, i) => {
    const where = `SH_TEMPLATE_HOSTS[${i}]`;
    const id = (h as { id?: unknown })?.id;
    if (typeof id !== 'string' || !HOST_ID_RE.test(id))
      throw new Error(`${where}: id must match ${HOST_ID_RE}`);
    if (seen.has(id)) throw new Error(`${where}: host '${id}' is listed twice`);
    seen.add(id);
    const name = hostTokenEnvName(id);
    const token = credentialValue(env, name) ?? '';
    if (!TOKEN_RE.test(token)) throw new Error(`${name} must be 64 hex characters`);
    if (tokens.has(token))
      throw new Error(`${name} must differ from every other host, egress and janitor token`);
    tokens.add(token);
    return { id, token };
  });
}
