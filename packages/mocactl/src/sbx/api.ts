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

/** A template quota (openapi Quota, template lifecycle spec §6.2). */
export type SbxQuota = { templates: number; buildsQueued: number; active: number };

/** The policy as `GET /v1/policy` answers it, as much of it as a quota write reads (§8). */
export interface SbxPolicyView {
  policy: { quota: SbxQuota; quotaBySubject?: Record<string, SbxQuota> };
  digest: string;
  record: string;
}

/** One build of a template (openapi TemplateBuild, template lifecycle spec §3.2, §3.3). */
export interface SbxBuild {
  buildId: string;
  status: string;
  profile: string;
  readiness: string | null;
  capacity: { running: number | null; inUse: number | null } | null;
  lastUsedAt: number | null;
  /**
   * The hosts whose last inventory holds its snapshot (template lifecycle spec §6.1); null without
   * host agents; absent from an older control plane.
   */
  heldBy?: string[] | null;
  tags: string[];
  createdAt: number;
  provenance: string | null;
  /** The handle the create answered; equal to buildId for an imported build. */
  handle?: string;
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

/** One build a retire answered for (openapi RetiredBuild, template lifecycle spec §5.1). */
export interface SbxRetiredBuild {
  /** The build's handle. */
  build: string;
  /** Null for a build retired before it registered. */
  buildId: string | null;
  readiness: 'retired';
  /** The retire record written now; null when it was already retired. */
  record: string | null;
}

/** What a retire answers: a whole template's (`builds`), or one build's (its fields inline). */
export interface SbxRetired extends Partial<SbxRetiredBuild> {
  templateId: string;
  subject: string;
  status: 'retired';
  builds?: SbxRetiredBuild[];
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

  /**
   * Retire a template (`POST /v1/templates/{id}/retire`), or one build of it (`DELETE
   * /v1/templates/{id}/builds/{build}`, which takes no reason).
   */
  retireTemplate(id: string, opts: { build?: string; reason?: string } = {}): Promise<SbxRetired> {
    const t = encodeURIComponent(id);
    return opts.build !== undefined
      ? this.json('DELETE', `/v1/templates/${t}/builds/${encodeURIComponent(opts.build)}`)
      : this.json('POST', `/v1/templates/${t}/retire`, {
          body: opts.reason !== undefined ? { reason: opts.reason } : {},
        });
  }

  /** The deployment's template policy (`GET /v1/policy`): its quotas, among the rest. */
  getPolicy(): Promise<SbxPolicyView> {
    return this.json('GET', '/v1/policy');
  }

  /**
   * Set a subject's quota, or the default; null removes a subject's override (§5.2; admins).
   * `expect`, when given, is the value read before: the control plane writes only if the target's
   * quota is that now, else `409 quota_changed` with nothing written. It goes as `?expect=` its
   * JSON (`null` for no override), percent-encoded by the URL's searchParams.
   */
  putQuota(
    target: string,
    quota: SbxQuota | null,
    expect?: SbxQuota | null,
  ): Promise<{
    target: string;
    subject: string;
    quota: SbxQuota | null;
    before: SbxQuota | null;
    policy: string;
    record: string;
  }> {
    return this.json('PUT', `/v1/quota/${encodeURIComponent(target)}`, {
      body: quota,
      query: { expect: expect === undefined ? undefined : JSON.stringify(expect) },
    });
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

  mintSandboxToken(id: string): Promise<SbxToken> {
    return this.json('POST', `/v1/sandboxes/${encodeURIComponent(id)}/token`);
  }
}
