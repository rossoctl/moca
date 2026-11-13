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

/** One build of a template (openapi TemplateBuild, template lifecycle spec §3.2, §3.3). */
export interface SbxBuild {
  buildId: string;
  /** The `b-<26 hex>` handle its create answered (its buildId for an imported build). */
  handle?: string;
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
  /**
   * A retired build whose snapshot or worker a build that is not retired shares: its worker is kept
   * for that build, never stopped for the retire. Absent from an older control plane.
   */
  shared?: boolean;
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

/** POST /v1/templates/{id}/tags's answer (template lifecycle spec §5.1). */
export interface SbxTagsMoved {
  templateId: string;
  subject: string;
  buildId: string;
  /** `before`: the build the tag named until now (null: new); `record`: null when unchanged. */
  tags: { tag: string; buildId: string; before: string | null; record: string | null }[];
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

  /** Move tags onto a registered build (lifecycle spec §5.1): `POST /v1/templates/{id}/tags`. */
  moveTemplateTags(id: string, tags: string[], build: string): Promise<SbxTagsMoved> {
    return this.json('POST', `/v1/templates/${encodeURIComponent(id)}/tags`, {
      body: { tags, build },
    });
  }

  /** Remove a tag; its build stays (lifecycle spec §5.1). */
  removeTemplateTag(
    id: string,
    tag: string,
  ): Promise<{ templateId: string; tag: string; before: string; record: string }> {
    return this.json(
      'DELETE',
      `/v1/templates/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`,
    );
  }

  /** Change a template's description or visibility (lifecycle spec §5.1). */
  updateTemplate(
    id: string,
    body: { visibility?: string; description?: string },
  ): Promise<{
    templateId: string;
    visibility: string;
    description: string;
    changes: { field: string; value: string; before: string; record: string }[];
  }> {
    return this.json('PATCH', `/v1/templates/${encodeURIComponent(id)}`, { body });
  }

  /** Transfer a template to another subject (lifecycle spec §5.2; admins). */
  transferTemplateOwner(
    id: string,
    owner: string,
  ): Promise<{ templateId: string; owner: string; before: string | null; record: string | null }> {
    return this.json('PUT', `/v1/templates/${encodeURIComponent(id)}/owner`, { body: { owner } });
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

  mintSandboxToken(id: string): Promise<SbxToken> {
    return this.json('POST', `/v1/sandboxes/${encodeURIComponent(id)}/token`);
  }
}
