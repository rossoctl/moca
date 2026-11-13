/**
 * A workload's own PVC (workload sandboxes spec §5.1, §6.3): its size and StorageClass, within the
 * operator's caps. `@moca/server`'s workloads.ts checks a create against them, and moca-provisioner
 * checks again before it creates the claim; one module, so the two can never disagree.
 */

/** How the claim may be attached: `rwo` one node (ReadWriteOnce), `rwx` any node (ReadWriteMany). */
export type StorageAccess = 'rwo' | 'rwx';

/** `workspace.mount`: the revision read-only, or a writable tree seeded from it (spec §5.3). */
export const WORKLOAD_MOUNTS = ['read-only', 'writable'] as const;
export type WorkloadMount = (typeof WORKLOAD_MOUNTS)[number];

const CLASS_NAME = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const SIZE = /^([1-9][0-9]{0,6})(Mi|Gi)$/;

/**
 * MOCA_WORKLOAD_STORAGE_CLASSES: `name:rwo` or `name:rwx` entries, comma-separated. Empty means the
 * cluster's default class, as ReadWriteOnce. Throws on anything else, naming the bad entry.
 */
export function parseStorageClasses(raw: string | undefined): Map<string, StorageAccess> {
  const classes = new Map<string, StorageAccess>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [name, access, extra] = trimmed.split(':');
    if (
      extra !== undefined ||
      !name ||
      !CLASS_NAME.test(name) ||
      (access !== 'rwo' && access !== 'rwx')
    ) {
      throw new Error(
        `MOCA_WORKLOAD_STORAGE_CLASSES entry '${trimmed}' is not '<class>:rwo' or '<class>:rwx'`,
      );
    }
    if (classes.has(name)) throw new Error(`MOCA_WORKLOAD_STORAGE_CLASSES lists '${name}' twice`);
    classes.set(name, access);
  }
  return classes;
}

/** `<n>Mi` or `<n>Gi` in MiB, or null when it is neither. */
export function storageMiB(size: unknown): number | null {
  const match = typeof size === 'string' ? SIZE.exec(size) : null;
  return match ? Number(match[1]) * (match[2] === 'Gi' ? 1024 : 1) : null;
}

export interface WorkloadStorageCaps {
  /** MOCA_WORKLOAD_MAX_STORAGE, in MiB. */
  maxMiB: number;
  /** MOCA_WORKLOAD_STORAGE_CLASSES, parsed. */
  classes: Map<string, StorageAccess>;
}

/** The claim to create; `storageClass` absent means the cluster's default class. */
export interface WorkloadStorage {
  size: string;
  storageClass?: string;
  access: StorageAccess;
}

/**
 * The claim for a requested size and class, or the 400 code to refuse it with. With an allowlist, a
 * request that names no class gets the first one listed, so the claim always carries a class the
 * admission policy allows; without one, it gets the default class and may name none.
 */
export function resolveWorkloadStorage(
  request: { size?: unknown; storageClass?: unknown },
  caps: WorkloadStorageCaps,
): WorkloadStorage | 'workspace_size_invalid' | 'storage_class_not_allowed' {
  const mib = storageMiB(request.size);
  if (mib === null || mib > caps.maxMiB) return 'workspace_size_invalid';
  const size = request.size as string;
  // `null` names no class, as an absent field does, in both branches.
  const requested = request.storageClass ?? undefined;
  if (caps.classes.size === 0) {
    return requested === undefined ? { size, access: 'rwo' } : 'storage_class_not_allowed';
  }
  const storageClass = requested ?? caps.classes.keys().next().value!;
  if (typeof storageClass !== 'string' || !caps.classes.has(storageClass)) {
    return 'storage_class_not_allowed';
  }
  return { size, storageClass, access: caps.classes.get(storageClass)! };
}
