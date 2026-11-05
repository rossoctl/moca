import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

/**
 * The few Kubernetes API calls the provisioner makes, all in ONE namespace (its Role's, workload
 * sandboxes spec §4.1). An interface, so the provisioner's rules are unit-tested against an
 * in-memory fake and only this file talks to a cluster.
 *
 * Plain REST over node:https rather than kubectl or a client library: the runtime image's kubectl
 * serves only the control plane's K8sSecretStore (deploy/k8s), and six verbs on six kinds do not
 * justify a dependency.
 */
export type Kind =
  'secrets' | 'services' | 'statefulsets' | 'pods' | 'podtemplates' | 'persistentvolumeclaims';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kubernetes objects are untyped here
export type KubeObject = { metadata: { name: string; [k: string]: any }; [k: string]: any };

export interface KubeApi {
  /** The object, or null when it does not exist. */
  get(kind: Kind, name: string): Promise<KubeObject | null>;
  /** Objects whose labels match `labelSelector` (`k=v,k2=v2`). */
  list(kind: Kind, labelSelector: string): Promise<KubeObject[]>;
  /** False when an object of that name already exists. */
  create(kind: Kind, obj: KubeObject): Promise<boolean>;
  /**
   * Full replace. Without a resourceVersion it is unconditional: how a re-minted token overwrites
   * its Secret without the provisioner ever reading one.
   */
  replace(kind: Kind, obj: KubeObject): Promise<void>;
  /** A JSON merge patch. */
  patch(kind: Kind, name: string, patch: object): Promise<void>;
  /** False when it was already gone. */
  delete(kind: Kind, name: string): Promise<boolean>;
}

/** A failed API call: the status and Kubernetes' `reason`, never the request body. */
export class KubeError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'KubeError';
  }
}

const GROUP: Record<Kind, string> = {
  secrets: '/api/v1',
  services: '/api/v1',
  pods: '/api/v1',
  podtemplates: '/api/v1',
  persistentvolumeclaims: '/api/v1',
  statefulsets: '/apis/apps/v1',
};

export interface RestKubeOptions {
  /** `https://host:port` in a cluster; `http://` only for tests. */
  baseUrl: string;
  namespace: string;
  /** Read per request: a projected ServiceAccount token is rotated in place by the kubelet. */
  token: () => string;
  ca?: Buffer;
}

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** The in-cluster API: KUBERNETES_SERVICE_HOST/PORT and the mounted ServiceAccount token and CA. */
export function inClusterOptions(env: NodeJS.ProcessEnv, namespace: string): RestKubeOptions {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host)
    throw new Error('KUBERNETES_SERVICE_HOST is not set: the provisioner runs in a cluster');
  return {
    baseUrl: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
    namespace,
    token: () => readFileSync(`${SA_DIR}/token`, 'utf8').trim(),
    ca: readFileSync(`${SA_DIR}/ca.crt`),
  };
}

export class RestKube implements KubeApi {
  constructor(private readonly o: RestKubeOptions) {}

  private path(kind: Kind, name?: string, query?: string): string {
    const ns = encodeURIComponent(this.o.namespace);
    const base = `${GROUP[kind]}/namespaces/${ns}/${kind}`;
    return `${base}${name ? `/${encodeURIComponent(name)}` : ''}${query ? `?${query}` : ''}`;
  }

  private request(
    method: string,
    path: string,
    body?: object,
    contentType = 'application/json',
  ): Promise<{ status: number; json: unknown }> {
    const url = new URL(path, this.o.baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const lib = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method,
          ca: this.o.ca,
          timeout: 15_000,
          headers: {
            authorization: `Bearer ${this.o.token()}`,
            accept: 'application/json',
            ...(payload === undefined
              ? {}
              : { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            let json: unknown = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString());
            } catch {
              /* a non-JSON body leaves json null */
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('Kubernetes API request timed out')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  /** Throws a KubeError for any status outside `ok`. */
  private async call(
    method: string,
    path: string,
    ok: number[],
    body?: object,
    contentType?: string,
  ): Promise<{ status: number; json: unknown }> {
    const r = await this.request(method, path, body, contentType);
    if (ok.includes(r.status)) return r;
    const reason = (r.json as { reason?: unknown } | null)?.reason;
    throw new KubeError(
      r.status,
      typeof reason === 'string' ? reason : 'Unknown',
      // Method and path only: the path names an object, never a token.
      `Kubernetes API ${method} ${path.split('?')[0]} answered ${r.status}`,
    );
  }

  async get(kind: Kind, name: string): Promise<KubeObject | null> {
    const r = await this.call('GET', this.path(kind, name), [200, 404]);
    return r.status === 404 ? null : (r.json as KubeObject);
  }

  async list(kind: Kind, labelSelector: string): Promise<KubeObject[]> {
    const q = `labelSelector=${encodeURIComponent(labelSelector)}`;
    const r = await this.call('GET', this.path(kind, undefined, q), [200]);
    return ((r.json as { items?: KubeObject[] }).items ?? []) as KubeObject[];
  }

  async create(kind: Kind, obj: KubeObject): Promise<boolean> {
    const r = await this.call('POST', this.path(kind), [200, 201, 202, 409], obj);
    return r.status !== 409;
  }

  async replace(kind: Kind, obj: KubeObject): Promise<void> {
    await this.call('PUT', this.path(kind, obj.metadata.name), [200, 201], obj);
  }

  async patch(kind: Kind, name: string, patch: object): Promise<void> {
    await this.call('PATCH', this.path(kind, name), [200], patch, 'application/merge-patch+json');
  }

  async delete(kind: Kind, name: string): Promise<boolean> {
    // Background: the StatefulSet goes at once and the garbage collector removes its pods, which
    // the caller then waits out by listing them.
    const r = await this.call('DELETE', this.path(kind, name), [200, 202, 404], {
      kind: 'DeleteOptions',
      apiVersion: 'v1',
      propagationPolicy: 'Background',
    });
    return r.status !== 404;
  }
}
