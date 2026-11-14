import { SubjectQueue } from './subject-document.js';
import type { TemplateCatalog } from './template-catalog.js';

/**
 * The deployment-wide activation lock. takeLease checks the subject's active quota and the hosts'
 * activeLimit against EVERY template's leases, then writes one template's lease; the catalog
 * serializes writes per template id only, so two activations of different templates (by one
 * subject, or placed on one host) could each pass the check before either lease was written, and
 * together overshoot. One lease-taking check-and-write at a time, per catalog, closes that: each
 * activation sees every earlier one's lease. It covers the policy read, the catalog read,
 * placement, the `activate` record and the lease write (record first, so no lease is stored
 * without its record), and nothing that calls a host. A path that only drops leases (deactivate)
 * does not take it: a drop can only free quota or a slot, so an activation that read the leases
 * before a drop judged against more leases than remain, never fewer. The wanted answer takes it
 * for its idle-grace stops' lease re-check (§6.5), so no lease is written between the re-check and
 * the answer. A retire takes it (§5.1): it ends a build's use, and takeLease re-reads the build's
 * status under it, so a lease is never written onto a build retired after the activation resolved
 * it. A sandbox create writes its record under it too, after the same re-read (notRetired), so no
 * sandbox lands on a build as it is retired; it holds the lock for one catalog read and one record
 * write.
 *
 * It is process-local, which suffices because one control plane process owns the store: the
 * Deployment runs one replica (deploy/k8s/base/control-plane.yaml), and the file catalog's volume is
 * ReadWriteOnce with the Recreate strategy (deploy/k8s/overlays/ocp-sbx/template-store), so no
 * second pod writes it, even during a rollout. A control plane with more than one replica on a
 * shared store would need a store-level lock (or a check-and-set on the whole catalog) instead.
 */
const ACTIVATION_LOCKS = new WeakMap<TemplateCatalog, SubjectQueue>();
export function activationLock(cat: TemplateCatalog): SubjectQueue {
  let q = ACTIVATION_LOCKS.get(cat);
  if (!q) ACTIVATION_LOCKS.set(cat, (q = new SubjectQueue()));
  return q;
}
