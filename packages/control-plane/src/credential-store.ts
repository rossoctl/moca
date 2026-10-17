import { CpError } from './errors.js';

/**
 * The credential model, keyed on the CONSUMER TIER rather than the service (spec §6.1): which trust
 * tier consumes a credential decides whether it can be delivered safely at all, so that -- not the
 * vendor -- is what the model is organized on. Keying on the service (inference.anthropic,
 * git.github) buries the governing property and makes every new service a schema change.
 *
 * All access goes through the CredentialStore interface so that slice 3 can move resolution behind
 * the Z3/Z5 injector, and an external manager (Vault / External Secrets) can replace per-user
 * Secrets, without reshaping a handler or an endpoint (spec §6.6).
 */
export type Consumer = 'inference' | 'sandbox-egress' | 'control-plane';

const CONSUMERS: readonly Consumer[] = ['inference', 'sandbox-egress', 'control-plane'];

export interface CredentialBinding {
  header: string;
  format: string;
}

/**
 * The two headers an INFERENCE credential can travel in (#368). A gateway (LiteLLM-style) reads
 * `Authorization: Bearer`; api.anthropic.com reads an API key ONLY from `x-api-key` and answers a
 * Bearer API key with an opaque 401. Lower-case because that is how they go on the wire.
 */
export type InferenceAuthHeader = 'authorization' | 'x-api-key';

/**
 * Which of the two headers a binding describes, or undefined when it is neither. `field` is the kind's
 * single secret field, so `{header: 'x-api-key', format: '{token}'}` on an `api-key` kind (field
 * `key`) is NOT sendable: its format names a field the secret does not have.
 *
 * Header names compare case-insensitively (HTTP), formats exactly: the format is a template, and a
 * near-miss like `Token {token}` is a different scheme, not a typo to forgive.
 */
export function inferenceAuthHeader(
  binding: CredentialBinding,
  field: string,
): InferenceAuthHeader | undefined {
  const header = binding.header.toLowerCase();
  if (header === 'authorization' && binding.format === `Bearer {${field}}`) return 'authorization';
  if (header === 'x-api-key' && binding.format === `{${field}}`) return 'x-api-key';
  return undefined;
}

const ANTHROPIC_API_HOST = 'api.anthropic.com';

/**
 * Refuse, at write time, the inference shapes known to 401 (#368, #362 item 3), so the failure lands
 * on the person who can fix it with a message naming the fix, never as an opaque 401 three turns in.
 * Messages name key PREFIXES only, never the value.
 */
function checkInferenceShape(
  field: string,
  binding: CredentialBinding,
  endpoint: string | null,
  value: string,
): void {
  const header = inferenceAuthHeader(binding, field);
  if (!header) {
    invalid(
      `an inference credential is sent as 'Authorization: Bearer {${field}}' or ` +
        `'x-api-key: {${field}}'; binding '${binding.header}: ${binding.format}' is neither`,
    );
  }
  // pi-ai adds the OAuth beta headers only when ITS apiKey is the token, and the harness never hands
  // it a caller's credential that way (MI1 R2), so an OAuth token here always 401s.
  if (value.startsWith('sk-ant-oat')) {
    invalid(
      'Anthropic OAuth tokens (sk-ant-oat…) are not supported as inference credentials; ' +
        "store an API key (sk-ant-api…) with kind 'api-key'",
    );
  }
  if (value.startsWith('sk-ant-api') && header === 'authorization') {
    invalid(
      'an Anthropic API key (sk-ant-api…) is read from x-api-key, not Authorization: ' +
        "store it with kind 'api-key'",
    );
  }
  if (endpoint) {
    const url = new URL(endpoint);
    if (url.hostname === ANTHROPIC_API_HOST) {
      if (header === 'authorization') {
        invalid(
          `${ANTHROPIC_API_HOST} reads API keys from x-api-key, not Authorization: ` +
            "store the key with kind 'api-key'",
        );
      }
      // The Anthropic client appends /v1/messages to its base URL, so `.../v1` becomes /v1/v1/messages.
      if (url.pathname !== '/' || url.search !== '') {
        invalid(
          `the endpoint for ${ANTHROPIC_API_HOST} is the bare origin https://${ANTHROPIC_API_HOST} ` +
            '(no /v1): the client adds /v1/messages itself',
        );
      }
    }
  }
}

export interface CredentialDescriptor {
  name: string;
  kind: string;
  consumer: Consumer;
  /** A host ALLOW-LIST, not a base URL (spec §6.3) -- the input slice 3's forward proxy needs. */
  destination: { hosts: string[] };
  binding: CredentialBinding;
  /** Full gateway origin; meaningful only for consumer `inference`, else null (spec §6.2). */
  endpoint: string | null;
}

export interface StoredCredential {
  descriptor: CredentialDescriptor;
  /** The ONLY encrypted part. Never returned by any /v1 route. */
  secret: Record<string, string>;
}

export interface CredentialStore {
  put(subject: string, cred: StoredCredential): Promise<void>;
  /** By EXACT name only -- there is deliberately no search or prefix path (spec §6.5). */
  get(subject: string, name: string): Promise<StoredCredential | null>;
  /** Descriptors only: `GET /v1/credentials` must list without decrypting anything. */
  list(subject: string): Promise<CredentialDescriptor[]>;
  delete(subject: string, name: string): Promise<void>;
}

/**
 * Names are user-chosen, so `github-work` and `github-personal` coexist (spec §6.2). The charset is
 * the intersection of three constraints, and narrowing any of them later is a breaking change:
 *   1. it becomes a Kubernetes Secret DATA KEY, which allows only [-._a-zA-Z0-9];
 *   2. it is half of envelope.ts's `subject|name` AAD, so it must not contain `|`;
 *   3. it appears in a URL path segment, so `/` and `..` must be impossible;
 *   4. it is embedded in a Kubernetes annotation NAME (`sh.io/destination.<name>`, see
 *      k8s-secret-store.ts) whose name half is capped at 63 chars -- hence the 40-char
 *      ceiling rather than 63.
 *
 * DNS-label-ish: a lone alphanumeric may not be flanked by hyphens, so neither end of the name is a
 * hyphen (`-leading` and `trailing-` are both refused) even though `-` is legal in the middle.
 */
export const CREDENTIAL_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

export function validateCredentialName(name: string): string {
  if (typeof name !== 'string' || !CREDENTIAL_NAME_RE.test(name)) {
    throw new CpError('invalid_request', `credential name must match ${CREDENTIAL_NAME_RE.source}`);
  }
  return name;
}

export interface KindSpec {
  /** Exactly the fields the `secret` object must carry -- no more, no fewer. */
  secretFields: string[];
  defaultBinding: CredentialBinding;
}

/**
 * `kind` is a REGISTRY entry carrying validation and binding rules, not a closed union: adding
 * SigV4 or an MCP server's token is a registry addition, not a migration (spec §6.2).
 */
const KINDS = new Map<string, KindSpec>([
  [
    'bearer',
    {
      secretFields: ['token'],
      defaultBinding: { header: 'Authorization', format: 'Bearer {token}' },
    },
  ],
  [
    'basic',
    {
      secretFields: ['username', 'password'],
      defaultBinding: { header: 'Authorization', format: 'Basic {base64(username:password)}' },
    },
  ],
  ['api-key', { secretFields: ['key'], defaultBinding: { header: 'X-API-Key', format: '{key}' } }],
  [
    'oauth2-token',
    {
      secretFields: ['accessToken'],
      defaultBinding: { header: 'Authorization', format: 'Bearer {accessToken}' },
    },
  ],
]);

export function registerKind(kind: string, spec: KindSpec): void {
  KINDS.set(kind, spec);
}

/**
 * The counterpart to `registerKind`. A registry that can only grow cannot be restored, so a test that
 * registers a kind leaks it into every later test in the same file -- which is exactly what happened
 * with `sigv4`. Returns whether the kind was present, so a caller can tell "removed" from "was never
 * there" rather than guessing.
 */
export function unregisterKind(kind: string): boolean {
  return KINDS.delete(kind);
}

export function kindSpec(kind: string): KindSpec {
  const spec = KINDS.get(kind);
  if (!spec) {
    throw new CpError(
      'invalid_request',
      `unknown credential kind '${kind}' (known: ${[...KINDS.keys()].join(', ')})`,
    );
  }
  return spec;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Mirrors `isRecord`: the shape check and the type it proves live in one place, so the caller assigns
 * `body.binding` to a CredentialBinding with no cast at all. What stood here was
 * `body.binding as unknown as CredentialBinding` after an equivalent inline check -- correct, but a
 * double cast silently outlives the check it was paired with if either one is later edited.
 */
const isCredentialBinding = (v: unknown): v is CredentialBinding =>
  isRecord(v) && typeof v.header === 'string' && typeof v.format === 'string';

// A `function` declaration, not a `const` arrow: TS's never-return control-flow narrowing (the
// reason `if (typeof x !== 'string') invalid(...)` lets `x` be used as `string` right after) is
// unreliable for an arrow assigned to a `never`-typed const once `x` has already been narrowed by an
// `!= null` check on an `unknown` -- it stays widened to `{}`. A function declaration narrows
// correctly in the same spot.
function invalid(why: string): never {
  throw new CpError('invalid_request', why);
}

/** The longest `endpoint` a credential may store (PR #540 review R3). */
export const MAX_ENDPOINT_LENGTH = 2048;

/** A host allow-list entry is a HOST, never a URL: `api.github.com`, not `https://api.github.com/x`. */
function validateHost(h: unknown): string {
  if (typeof h !== 'string' || h.length === 0 || /[:/?#]/.test(h)) {
    invalid(`destination.hosts entries must be bare hostnames, got '${String(h)}'`);
  }
  return h as string;
}

export function parseCredentialBody(name: string, body: unknown): StoredCredential {
  validateCredentialName(name);
  if (!isRecord(body)) invalid('credential body must be a JSON object');

  const kind = typeof body.kind === 'string' ? body.kind : invalid('kind is required');
  const spec = kindSpec(kind);

  const consumer = body.consumer;
  if (typeof consumer !== 'string' || !CONSUMERS.includes(consumer as Consumer)) {
    invalid(`consumer must be one of ${CONSUMERS.join(', ')}`);
  }

  // An `inference` credential is delivered as ONE Bearer token, and the exchange reads the kind's
  // single secret field as that value (exchange.ts). A multi-field kind here would send the wrong
  // half upstream -- `basic` would send the USERNAME as the bearer -- which is a misdirected secret,
  // not a degraded request. Refused at write time so the failure lands on the person who can fix it,
  // with a message naming the kind, rather than three turns later as an opaque 401 from the gateway.
  if (consumer === 'inference' && spec.secretFields.length !== 1) {
    invalid(
      `consumer 'inference' needs a single-secret-field kind; '${kind}' declares ` +
        `${spec.secretFields.length} (${spec.secretFields.join(', ')})`,
    );
  }

  const dest = body.destination;
  if (!isRecord(dest) || !Array.isArray(dest.hosts) || dest.hosts.length === 0) {
    invalid('destination.hosts must be a non-empty array');
  }
  const hosts = (dest as { hosts: unknown[] }).hosts.map(validateHost);

  let binding = spec.defaultBinding;
  if (body.binding !== undefined) {
    if (!isCredentialBinding(body.binding)) invalid('binding must be { header, format }');
    binding = body.binding;
  }

  // `endpoint` is meaningful ONLY for inference. Accepting it elsewhere would create a second,
  // silently ignored notion of "where this credential goes" alongside destination.hosts.
  let endpoint: string | null = null;
  if (body.endpoint !== undefined && body.endpoint !== null) {
    if (consumer !== 'inference') invalid('endpoint is only valid for consumer: inference');
    if (typeof body.endpoint !== 'string') invalid('endpoint must be a string');
    // Capped at store time (PR #540 review R3): every catalog call and exchange parses it, and the
    // value is the user's to choose. No real gateway URL is near the cap.
    if (body.endpoint.length > MAX_ENDPOINT_LENGTH) {
      invalid(`endpoint must be at most ${MAX_ENDPOINT_LENGTH} characters`);
    }
    let parsed: URL;
    try {
      parsed = new URL(body.endpoint);
    } catch {
      // `invalid` is declared `: never`, so no `return` here or above -- one call style throughout.
      invalid('endpoint must be an absolute URL, e.g. https://litellm.internal/v1');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      invalid('endpoint must be http(s)');
    }
    endpoint = body.endpoint;
  }

  if (!isRecord(body.secret)) invalid('secret must be an object');
  const secretIn = body.secret as Record<string, unknown>;
  const given = Object.keys(secretIn).sort();
  const want = [...spec.secretFields].sort();
  // Exactly the declared fields. An undeclared extra is rejected rather than stored: a typo'd field
  // name would otherwise persist silently and fail at use time with nothing to point at.
  if (given.length !== want.length || given.some((k, i) => k !== want[i])) {
    invalid(`kind '${kind}' requires secret fields: ${want.join(', ')}`);
  }
  const secret: Record<string, string> = {};
  for (const field of spec.secretFields) {
    const v = secretIn[field];
    if (typeof v !== 'string' || v.length === 0)
      invalid(`secret.${field} must be a non-empty string`);
    secret[field] = v as string;
  }

  if (consumer === 'inference') {
    // Exactly one secret field here: the single-field refusal above guarantees it.
    const field = spec.secretFields[0]!;
    checkInferenceShape(field, binding, endpoint, secret[field]!);
  }

  return {
    descriptor: {
      name,
      kind,
      consumer: consumer as Consumer,
      destination: { hosts },
      binding,
      endpoint,
    },
    secret,
  };
}

/**
 * Which credential a session's turns run on (spec §6.4). With several and none named it returns
 * `credential_ambiguous` rather than picking silently; with none it returns `credential_required` at
 * SESSION CREATION -- a missing key should fail there, not three turns in.
 */
export function resolveInferenceName(
  descriptors: CredentialDescriptor[],
  requested?: string,
): string {
  if (requested !== undefined) {
    const found = descriptors.find((d) => d.name === requested);
    if (!found) {
      throw new CpError('credential_not_found', `no credential named '${requested}'`);
    }
    if (found.consumer !== 'inference') {
      throw new CpError(
        'invalid_request',
        `credential '${requested}' has consumer '${found.consumer}', not 'inference'`,
      );
    }
    return requested;
  }
  const inference = descriptors.filter((d) => d.consumer === 'inference');
  if (inference.length === 0) {
    throw new CpError('credential_required', 'no credential with consumer: inference');
  }
  if (inference.length > 1) {
    throw new CpError(
      'credential_ambiguous',
      `several inference credentials (${inference.map((d) => d.name).join(', ')}); name one`,
    );
  }
  return inference[0]!.name;
}

/** For unit tests and a cluster-free local run. Never used in a deployed control plane. */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly bySubject = new Map<string, Map<string, StoredCredential>>();

  async put(subject: string, cred: StoredCredential): Promise<void> {
    const forSubject = this.bySubject.get(subject) ?? new Map<string, StoredCredential>();
    forSubject.set(cred.descriptor.name, cred);
    this.bySubject.set(subject, forSubject);
  }

  async get(subject: string, name: string): Promise<StoredCredential | null> {
    return this.bySubject.get(subject)?.get(name) ?? null;
  }

  async list(subject: string): Promise<CredentialDescriptor[]> {
    return [...(this.bySubject.get(subject)?.values() ?? [])].map((c) => c.descriptor);
  }

  async delete(subject: string, name: string): Promise<void> {
    this.bySubject.get(subject)?.delete(name);
  }
}

/**
 * The sandbox profile's credential store: there is none (SBX0 §4.1), and the routes that would use
 * one are not mounted. Fail-closed rather than an empty store, so a wiring mistake surfaces as an
 * error instead of a silent "no credentials".
 */
export class UnavailableCredentialStore implements CredentialStore {
  private refuse(): never {
    throw new CpError('internal_error', 'no credential store on the sandbox profile');
  }
  async put(): Promise<void> {
    this.refuse();
  }
  async get(): Promise<StoredCredential | null> {
    this.refuse();
  }
  async list(): Promise<CredentialDescriptor[]> {
    this.refuse();
  }
  async delete(): Promise<void> {
    this.refuse();
  }
}
