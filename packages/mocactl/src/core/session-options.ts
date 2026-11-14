import type { ControlPlaneApi, CreateSessionRequest, Discovery } from '../api/types.js';
import type { Preset } from '../config.js';
import { ApiError } from '../api/errors.js';
import { sanitizeRemote } from './sanitize.js';

// Spec §7.3. Supporting a new session-time parameter (a model, a sandbox selector) is one more
// entry in SESSION_OPTION_FIELDS; the New Session overlay, presets and `run --option` all read it.

export interface Choice {
  value: string;
  label: string;
  /** The server's own default (P6.3's sandbox tier): preselected when nothing was used last. */
  isDefault?: boolean;
}

export interface SessionOptionField {
  key: string;
  label: string;
  emptyHint: string;
  /**
   * With no choice to offer, leave the field unset and let the server decide rather than block: the
   * control plane may have a default of its own (the operator fallback credential, #368; no tier on
   * an untiered deployment).
   */
  serverMayResolve?: boolean;
  /**
   * The error code with which the server refuses a session that left this field unset; such a
   * refusal is mapped back to this field's `emptyHint` by fieldRefusedByServer.
   */
  refusalCode?: string;
  /**
   * The server has its own default for this field (P6.3's sandbox tier): a non-interactive caller
   * that did not choose leaves it unset instead of being refused with "choose with --option".
   */
  serverDefaults?: boolean;
  /**
   * With no choices to offer (the catalog is unavailable), send a value the caller gave as-is for
   * the server to check, rather than blocking (per-session model spec §4.2: accepted unverified).
   */
  acceptUnlisted?: boolean;
  /**
   * A value the caller gave that is not among the choices is still sent, even when there are
   * choices, for the server to resolve and check: the sandbox template, whose choices are only the
   * deployment's declared ids while a control plane with a template store may also resolve
   * references such as `id:tag` and `id@<build>`. A wrong one is the server's refusal, shown as
   * the server words it.
   */
  sendUnlisted?: boolean;
  /** `values` are the fields resolved before this one, so a choice can depend on them (the model on the credential). */
  source(api: ControlPlaneApi, values: Record<string, string>): Promise<Choice[]>;
  toRequest(value: string, req: CreateSessionRequest): CreateSessionRequest;
}

export const inferenceCredentialField: SessionOptionField = {
  key: 'inferenceCredential',
  label: 'Inference credential',
  emptyHint: 'add an inference credential to start',
  serverMayResolve: true,
  refusalCode: 'credential_required',
  async source(api, _values) {
    return (await api.listCredentials())
      .filter((c) => c.consumer === 'inference')
      .map((c) => {
        // The picker's label is shown terminal-safe; `value` stays the raw name, which is the id
        // sent back to the server.
        const name = sanitizeRemote(c.name);
        return {
          value: c.name,
          label: c.endpoint ? `${name}  ${sanitizeRemote(c.endpoint)}` : name,
        };
      });
  },
  toRequest: (value, req) => ({ ...req, credentials: { ...req.credentials, inference: value } }),
};

export const sandboxTierField: SessionOptionField = {
  key: 'sandboxTier',
  label: 'Sandbox tier',
  emptyHint: 'this deployment declares no sandbox tiers',
  serverMayResolve: true,
  serverDefaults: true,
  async source(api, _values) {
    let tiers: Discovery['sandboxTiers'];
    try {
      tiers = (await api.discovery()).sandboxTiers;
    } catch (err) {
      // A control plane that predates /v1/discovery (used with --harness-url, api/discovery.ts)
      // predates tiers too: offer none, so the field is skipped. Any other failure is real.
      if (err instanceof ApiError && err.status === 404) return [];
      throw err;
    }
    // A remote body: anything but { names: string[], default: string } counts as no tiers, so a
    // malformed discovery skips the field rather than breaking session creation with a TypeError.
    if (!isSandboxTiers(tiers)) return [];
    return tiers.names.map((n) => ({
      value: n,
      label: sanitizeRemote(n),
      ...(n === tiers.default ? { isDefault: true } : {}),
    }));
  },
  toRequest: (value, req) => ({ ...req, sandbox: { ...req.sandbox, tier: value } }),
};

/**
 * The session's sandbox template (session-templates spec §6). 'none' is a real choice, offered
 * first and preselected: a session with no template runs on untemplated workers, so a deployment
 * that declares one template must not have it picked for every session (the one-choice shortcut).
 * '' means "send no template".
 */
export const sandboxTemplateField: SessionOptionField = {
  key: 'sandboxTemplate',
  label: 'Sandbox template',
  emptyHint: 'this deployment declares no sandbox templates',
  serverMayResolve: true,
  serverDefaults: true,
  sendUnlisted: true,
  async source(api, _values) {
    let templates: Discovery['sandboxTemplates'];
    try {
      templates = (await api.discovery()).sandboxTemplates;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return [];
      throw err;
    }
    if (!Array.isArray(templates)) return [];
    const ids = templates
      .map((t) => (t && typeof t === 'object' ? (t as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && id !== '');
    if (ids.length === 0) return [];
    return [
      { value: '', label: 'none', isDefault: true },
      ...ids.map((id) => ({ value: id, label: sanitizeRemote(id) })),
    ];
  },
  toRequest: (value, req) =>
    value === '' ? req : { ...req, sandbox: { ...req.sandbox, template: value } },
};

function isSandboxTiers(v: unknown): v is NonNullable<Discovery['sandboxTiers']> {
  if (typeof v !== 'object' || v === null) return false;
  const { names, default: def } = v as Record<string, unknown>;
  return (
    Array.isArray(names) && names.every((n) => typeof n === 'string') && typeof def === 'string'
  );
}

/**
 * `200k ctx` for 200000: the label's only job is telling a big window from a small one. A remote
 * value, so undefined unless it is a finite positive number (PR #540 review R6) -- anything else
 * would reach the label through String() unsanitized. Shared with the /model overlay.
 */
export function formatWindow(n: unknown): string | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return `${n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)} ctx`;
}

/** The catalog's entries with a string id; a body without a models array has none (R6). */
function catalogEntries(list: unknown): Array<{ id: string; contextWindow?: unknown }> {
  const models = (list as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  return models.filter(
    (m): m is { id: string; contextWindow?: unknown } =>
      typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string',
  );
}

export const modelField: SessionOptionField = {
  key: 'model',
  label: 'Model',
  emptyHint: 'the inference credential lists no models',
  serverMayResolve: true,
  serverDefaults: true,
  acceptUnlisted: true,
  async source(api, values) {
    let list;
    try {
      list = await api.listModels(values.inferenceCredential);
    } catch (err) {
      // No catalog to offer: a control plane that predates it (a route 404, as distinct from a
      // named credential that does not exist), a gateway that cannot list, or a subject with no
      // credential at all (create then refuses with the credential field's own hint). The session
      // runs on the deployment default. Anything else is real.
      // A 503 is skipped whatever its code (spec §6): an unavailable catalog, by any name.
      if (
        err instanceof ApiError &&
        ((err.status === 404 && err.code !== 'credential_not_found') ||
          err.status === 503 ||
          err.code === 'model_catalog_unavailable' ||
          err.code === 'credential_required')
      ) {
        return [];
      }
      throw err;
    }
    // A remote body, shape-checked as sandboxTierField's is: a 200 without a models array skips the
    // field rather than breaking New Session and `mocactl run` with a TypeError (R6).
    const models = catalogEntries(list).map((m) => {
      const id = sanitizeRemote(m.id);
      const window = formatWindow(m.contextWindow);
      return { value: m.id, label: window ? `${id}  ${window}` : id };
    });
    // The deployment default is always a choice (final review F3): without it a one-model catalog
    // would be auto-pinned, and New Session could never leave the model to the deployment. '' is
    // never a model id (MODEL_ID_RE); it means "send no model", for a preset or last use too.
    if (models.length === 0) return [];
    return [{ value: '', label: 'deployment default', isDefault: true }, ...models];
  },
  toRequest: (value, req) => (value === '' ? req : { ...req, model: value }),
};

export const SESSION_OPTION_FIELDS: readonly SessionOptionField[] = [
  inferenceCredentialField,
  modelField,
  sandboxTierField,
  sandboxTemplateField,
];

export type Resolution =
  | { status: 'ready'; values: Record<string, string>; request: CreateSessionRequest }
  | {
      status: 'needs-input';
      field: SessionOptionField;
      choices: Choice[];
      defaultValue?: string;
      values: Record<string, string>;
    }
  | { status: 'blocked'; field: SessionOptionField; values: Record<string, string> };

export async function resolveSessionOptions(
  api: ControlPlaneApi,
  fields: readonly SessionOptionField[],
  given: Record<string, string>,
  lastUsed: Record<string, string>,
  opts: { interactive?: boolean } = {},
): Promise<Resolution> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const choices = await field.source(api, values);
    const wanted = given[field.key];
    if (wanted !== undefined && choices.some((c) => c.value === wanted)) {
      values[field.key] = wanted;
      continue;
    }
    if (wanted !== undefined && wanted !== '' && field.sendUnlisted) {
      values[field.key] = wanted;
      continue;
    }
    if (choices.length === 0) {
      if (wanted !== undefined && field.acceptUnlisted) {
        values[field.key] = wanted;
        continue;
      }
      if (field.serverMayResolve && wanted === undefined) continue;
      return { status: 'blocked', field, values };
    }
    if (choices.length === 1 && wanted === undefined) {
      values[field.key] = choices[0].value;
      continue;
    }
    // A field the server defaults (the sandbox tier) is not a question for a script: leave it unset.
    if (opts.interactive === false && field.serverDefaults && wanted === undefined) continue;
    const last = lastUsed[field.key];
    return {
      status: 'needs-input',
      field,
      choices,
      defaultValue: choices.some((c) => c.value === last)
        ? last
        : choices.find((c) => c.isDefault)?.value,
      values,
    };
  }
  let request: CreateSessionRequest = {};
  for (const field of fields) {
    if (values[field.key] !== undefined) request = field.toRequest(values[field.key], request);
  }
  return { status: 'ready', values, request };
}

/**
 * The field a `POST /v1/sessions` refusal is about, when the server declined to resolve one the
 * client left to it (matched on its refusalCode): the caller then shows that field's emptyHint, as
 * if blocked.
 */
export function fieldRefusedByServer(
  err: unknown,
  fields: readonly SessionOptionField[],
): SessionOptionField | undefined {
  if (!(err instanceof ApiError)) return undefined;
  return fields.find((f) => f.refusalCode !== undefined && f.refusalCode === err.code);
}

export function checkPreset(
  preset: Preset,
  fields: readonly SessionOptionField[],
): { values: Record<string, string>; stale: string[] } {
  const known = new Set(fields.map((f) => f.key));
  const values: Record<string, string> = {};
  const stale: string[] = [];
  for (const [k, v] of Object.entries(preset.values)) {
    if (known.has(k)) values[k] = v;
    else stale.push(k);
  }
  return { values, stale };
}

export function parseOptionFlags(flags: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags) {
    const eq = f.indexOf('=');
    if (eq <= 0) throw new Error(`--option expects key=value, got "${f}"`);
    out[f.slice(0, eq)] = f.slice(eq + 1);
  }
  return out;
}
