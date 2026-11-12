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

/** A subject as `GET /v1/subjects` lists it (enrollment and roles through the API). */
export interface SbxSubject {
  subject: string;
  enrolled: boolean;
  source: 'env' | 'api';
  roles: { role: string; source: 'env' | 'api'; until: number | null; by: string | null }[];
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

  /** Every enrolled subject, with its roles (enrollment and roles spec §4; admins). */
  async listSubjects(): Promise<SbxSubject[]> {
    return (await this.json<{ subjects: SbxSubject[] }>('GET', '/v1/subjects')).subjects;
  }

  /** Enroll a subject (an admin named in the settings). */
  enrollSubject(subject: string): Promise<SbxSubject & { record: string | null }> {
    return this.json('PUT', `/v1/subjects/${encodeURIComponent(subject)}`, {
      body: { enrolled: true },
    });
  }

  /** Unenroll a subject enrolled through the API (an admin named in the settings). */
  unenrollSubject(subject: string): Promise<SbxSubject & { record: string | null }> {
    return this.json('DELETE', `/v1/subjects/${encodeURIComponent(subject)}`);
  }

  /** Grant the admin role, optionally until an epoch second (an admin named in the settings). */
  grantAdmin(subject: string, until?: number): Promise<SbxSubject & { record: string | null }> {
    return this.json('PUT', `/v1/subjects/${encodeURIComponent(subject)}/roles/admin`, {
      body: until === undefined ? {} : { until },
    });
  }

  /** Revoke an API-granted admin role (an admin named in the settings). */
  revokeAdmin(subject: string): Promise<SbxSubject & { record: string | null }> {
    return this.json('DELETE', `/v1/subjects/${encodeURIComponent(subject)}/roles/admin`);
  }
}
