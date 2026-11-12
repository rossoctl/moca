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
