import { randomUUID } from 'node:crypto';
import { open as openFile, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProvenanceStore } from './provenance.js';
import {
  DEFAULT_POLICY,
  policyDigest,
  policyProblems,
  type Policy,
  type PolicyStore,
} from './template-policy.js';

/** PolicyStore on the provenance directory: policy.json, and its record's digest beside it. */
export class FilePolicyStore implements PolicyStore {
  private readonly path: string;
  private readonly provenance: ProvenanceStore;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(opts: { dir: string; provenance: ProvenanceStore }) {
    this.path = join(opts.dir, 'policy.json');
    this.provenance = opts.provenance;
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.pending.then(op, op);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<{ policy: Policy; record: string } | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const doc = JSON.parse(raw) as { policy: Policy; record: string };
    const bad = policyProblems(doc.policy);
    if (bad.length) throw new Error(`policy.json is invalid: ${bad.join('; ')}`);
    return doc;
  }

  private async write(
    policy: Policy,
    subject: string,
    extra?: Record<string, unknown>,
  ): Promise<{ policy: Policy; record: string }> {
    const { digest } = await this.provenance.append({
      stream: 'policy',
      kind: 'policy',
      subject,
      body: {
        policy: policy as unknown as Record<string, unknown>,
        digest: policyDigest(policy),
        ...(extra ?? {}),
      },
    });
    const doc = { policy, record: digest };
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fh = await openFile(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(JSON.stringify(doc));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    return doc;
  }

  current(): Promise<{ policy: Policy; record: string }> {
    return this.serial(async () => (await this.read()) ?? this.write(DEFAULT_POLICY, 'deployment'));
  }

  set(
    policy: Policy,
    subject: string,
    extra?: Record<string, unknown>,
  ): Promise<{ policy: Policy; record: string }> {
    const bad = policyProblems(policy);
    if (bad.length) return Promise.reject(new Error(bad.join('; ')));
    return this.serial(() => this.write(policy, subject, extra));
  }
}
