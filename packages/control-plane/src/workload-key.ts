import { createHash } from 'node:crypto';

/**
 * The names a workload is known by outside its Redis record (workload sandboxes spec §3.1, §4.1).
 * `@moca/server`'s workloads.ts derives them for the record and its Context; moca-provisioner
 * derives them again, from the owner of a verified API token, for the workload's sandbox objects and
 * its attach token. One module, so the two can never disagree.
 */

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The owner scope: the first 32 hex of sha256(owner). It keys the owner's Redis records and is an
 * attach token's `own`. Anyone who knows the owner can compute it, which is fine for both.
 */
export function ownerScopeFor(owner: string): string {
  return sha256(owner).slice(0, 32);
}

/**
 * The workload key: `w-` + the first 32 hex of sha256(owner \0 name \0 generation). Unique per
 * owner, name and reservation. It names the workload's Context, its StatefulSet, Service and
 * attach Secret, and is an attach token's `wl`.
 */
export function workloadKeyFor(owner: string, name: string, generation: string): string {
  return `w-${sha256(`${owner}\0${name}\0${generation}`).slice(0, 32)}`;
}

/**
 * The workload record's Redis key. `sh:wl:`, not `sh:workload:`: the upgrade note's cleanup of
 * legacy records (`sh:workload:*`, docs/context-service.md) must never match a live workload.
 */
export function workloadRecordKey(owner: string, name: string): string {
  return `sh:wl:${ownerScopeFor(owner)}:${name}`;
}
