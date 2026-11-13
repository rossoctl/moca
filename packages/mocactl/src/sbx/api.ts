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
  summary: SbxEgressSummary;
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
  status: string;
  profile: string;
  readiness: string | null;
  capacity: { running: number; inUse: number | null } | null;
  lastUsedAt: number | null;
  tags: string[];
  createdAt: number;
  provenance: string | null;
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

  /** One build, by its build id (`GET /v1/templates/{id}/builds/{build}`). */
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
