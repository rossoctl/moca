import { ControlPlaneClient } from '../api/control-plane.js';

/** The sandbox service's HTTP API (SBX0 §5.1), on top of the control-plane client's auth and retry. */
export interface SbxTemplate {
  id: string;
  description: string;
  tools: string[];
  /** The default build's readiness (template lifecycle spec §3.3); absent from an older control plane. */
  readiness?: string | null;
  /** tag -> build id; absent from an older control plane. */
  tags?: Record<string, string>;
}

export interface SbxSandbox {
  id: string;
  owner: string;
  name: string | null;
  template: string;
  state: 'ready' | 'terminated';
  reason: 'deleted' | 'expired' | null;
  createdAt: number;
  expiresAt: number;
  terminatedAt: number | null;
  labels: Record<string, string>;
}

export interface SbxToken {
  token: string;
  expiresAt: number;
  execEndpoint: string;
  wrk: string;
  wsk: string;
  execCa: string | null;
}

/**
 * `/v1/discovery` as the sandbox service reads it (SBX0 §4.1). Only `profile` is relied on: a
 * control plane that predates profiles omits it and is a harness (MOCA) one.
 */
export interface SbxDiscovery {
  profile?: string;
}

/** A sandbox's egress log, a page at a time: the proxy's events as it wrote them. */
export interface SbxEgressPage {
  events: Record<string, unknown>[];
  next: string | null;
  /** On the first page only (it reads the whole log); null on the pages after `after`. */
  summary: SbxEgressSummary | null;
}

/** The log's summary (openapi EgressSummary): per destination host, completeness and digest. */
export interface SbxEgressSummary {
  byHost: Record<
    string,
    { count: number; decisions: Record<string, number>; bytesUp: number; bytesDown: number }
  >;
  total: number;
  dropped: number;
  droppedBy?: { proxy: number; cap: number; budget?: number; invalid: number };
  complete: boolean;
  sealed?: boolean;
  sha256: string;
}

/** One build of a template (openapi TemplateBuild, template lifecycle spec §3.2, §3.3). */
export interface SbxBuild {
  buildId: string;
  /** The `b-<26 hex>` handle its create answered (its buildId for an imported build). */
  handle?: string;
  status: string;
  profile: string;
  readiness: string | null;
  capacity: { running: number; inUse: number | null } | null;
  lastUsedAt: number | null;
  tags: string[];
  createdAt: number;
  provenance: string | null;
  /** On a `failed` or `rejected` build, why (`step` `cancelled` for a cancel); null otherwise. */
  reason?: { message: string; step?: string; rule?: string } | null;
  /** On GET /v1/templates/{id} and the builds routes. */
  spec?: {
    guest_mb?: number;
    vcpus?: number;
    workspace_mb?: number;
    seed?: string;
    tools?: string[];
  };
}

/** An activation lease (POST /v1/templates/{id}/activate, template lifecycle spec §6.3). */
export interface SbxLease {
  templateId: string;
  buildId: string;
  /** Epoch seconds. */
  leaseUntil: number;
  /** The host it is placed on; null while no host agent has reported. */
  host: string | null;
}

/** A template with its builds (openapi Template). */
export interface SbxTemplateFull extends SbxTemplate {
  owner: string | null;
  visibility: 'private' | 'deployment';
  onboarding: string | null;
  readiness: string | null;
  tags: Record<string, string>;
  builds: SbxBuild[];
}

/** What a create answers (openapi TemplateQueued): the build to follow. */
export interface SbxQueued {
  templateId: string;
  buildId: string | null;
  /** The build's path, `/v1/templates/{id}/builds/{handle}` (or its buildId once registered). */
  build: string;
  status: string;
  reused?: boolean;
}

/** The body of a template create (openapi TemplateCreate). */
export interface SbxTemplateCreate {
  id?: string;
  image: string;
  spec: Record<string, unknown>;
  profile?: string;
  /** The gate record file as sent, byte for byte. */
  gateRecord?: string;
  visibility?: string;
}

export type SbxLimitUse = { limit: number; used: number };

/** `GET /v1/quota`: the caller's template quotas and use, and on the sandbox profile its live-sandbox cap. */
export interface SbxQuotaView {
  subject: string;
  templates: SbxLimitUse;
  buildsQueued: SbxLimitUse;
  active: SbxLimitUse;
  sandboxes?: SbxLimitUse;
}

/** A policy profile (openapi Policy.profiles). */
export interface SbxProfile {
  requires: string[];
  envelope: {
    maxGuestMb: number;
    maxVcpus: number;
    maxWorkspaceMb: number;
    exact?: { guestMb: number; vcpus: number };
  };
}

/** `GET /v1/policy` (openapi PolicyView). */
export interface SbxPolicyView {
  policy: {
    schema: string;
    profiles: Record<string, SbxProfile>;
    defaultProfile: string;
    allowedRegistries: string[];
    trustedGateRecords: string[];
    quota: { templates: number; buildsQueued: number; active: number };
  };
  digest: string;
  record: string;
}

export class SandboxApiClient extends ControlPlaneClient {
  sandboxDiscovery(): Promise<SbxDiscovery> {
    return this.json('GET', '/v1/discovery', { auth: false });
  }

  async listTemplates(): Promise<SbxTemplate[]> {
    return (await this.json<{ templates: SbxTemplate[] }>('GET', '/v1/templates')).templates;
  }

  /** One template with its builds and their specs (`GET /v1/templates/{id}`). */
  getTemplate(id: string): Promise<SbxTemplateFull> {
    return this.json('GET', `/v1/templates/${encodeURIComponent(id)}`);
  }

  /** One build, by build id or by the create's handle (`GET /v1/templates/{id}/builds/{b}`). */
  getTemplateBuild(id: string, build: string): Promise<SbxBuild> {
    return this.json(
      'GET',
      `/v1/templates/${encodeURIComponent(id)}/builds/${encodeURIComponent(build)}`,
    );
  }

  /** Take or renew the caller's activation lease on a build (`POST /v1/templates/{id}/activate`). */
  activateTemplate(
    id: string,
    body: { tag?: string; build?: string; leaseSeconds?: number },
  ): Promise<SbxLease> {
    return this.json('POST', `/v1/templates/${encodeURIComponent(id)}/activate`, { body });
  }

  /** Release the caller's activation leases on a template (`POST /v1/templates/{id}/deactivate`). */
  deactivateTemplate(id: string): Promise<{ templateId: string; released: number }> {
    return this.json('POST', `/v1/templates/${encodeURIComponent(id)}/deactivate`, { body: {} });
  }

  /** Create a template, or a new build of one's own (lifecycle spec §4): `POST /v1/templates`. */
  createTemplate(body: SbxTemplateCreate): Promise<SbxQueued> {
    return this.json('POST', '/v1/templates', { body });
  }

  /** A new build of one's own template: `POST /v1/templates/{id}/builds` (the body's id ignored). */
  createTemplateBuild(id: string, body: SbxTemplateCreate): Promise<SbxQueued> {
    return this.json('POST', `/v1/templates/${encodeURIComponent(id)}/builds`, { body });
  }

  /** Withdraw a queued, building or probing build (the owner, or an admin). */
  cancelTemplateBuild(
    id: string,
    build: string,
  ): Promise<{ templateId: string; build: string; status: 'failed' }> {
    return this.json(
      'POST',
      `/v1/templates/${encodeURIComponent(id)}/builds/${encodeURIComponent(build)}/cancel`,
    );
  }

  /** The caller's template quotas and use, and the live-sandbox cap (§6.2). */
  getQuota(): Promise<SbxQuotaView> {
    return this.json('GET', '/v1/quota');
  }

  /** The deployment's template policy (§8): profiles, registries, quotas, and its digest. */
  getPolicy(): Promise<SbxPolicyView> {
    return this.json('GET', '/v1/policy');
  }

  createSandbox(body: {
    template: string;
    name?: string;
    labels?: Record<string, string>;
  }): Promise<SbxSandbox & { buildId?: string | null; templateManifestHash?: string | null }> {
    return this.json('POST', '/v1/sandboxes', { body });
  }

  async listSandboxes(opts: { all?: boolean } = {}): Promise<SbxSandbox[]> {
    return (
      await this.json<{ sandboxes: SbxSandbox[] }>('GET', '/v1/sandboxes', {
        query: { all: opts.all ? '1' : undefined },
      })
    ).sandboxes;
  }

  getSandbox(id: string): Promise<SbxSandbox> {
    return this.json('GET', `/v1/sandboxes/${encodeURIComponent(id)}`);
  }

  deleteSandbox(id: string): Promise<{ id: string; state: 'terminated'; reason: string }> {
    return this.json('DELETE', `/v1/sandboxes/${encodeURIComponent(id)}`);
  }

  /** One page of a sandbox's egress log (owner or admin), from `after` (a page's `next`). */
  sandboxEgress(id: string, opts: { after?: string; limit?: number } = {}): Promise<SbxEgressPage> {
    return this.json('GET', `/v1/sandboxes/${encodeURIComponent(id)}/egress`, {
      query: { after: opts.after, limit: opts.limit },
    });
  }

  /**
   * The whole log as NDJSON, byte for byte as served: its sha256 is the summary's. The bytes, never
   * a decoded string, so neither a UTF-8 decoder's replacements nor a BOM's removal can change them.
   */
  async sandboxEgressNdjson(id: string): Promise<Buffer> {
    const res = await this.request('GET', `/v1/sandboxes/${encodeURIComponent(id)}/egress`, {
      query: { format: 'ndjson' },
    });
    return Buffer.from(await res.arrayBuffer());
  }

  mintSandboxToken(id: string): Promise<SbxToken> {
    return this.json('POST', `/v1/sandboxes/${encodeURIComponent(id)}/token`);
  }
}
