/**
 * Re-export only. The implementation moved to @moca/control-plane (#387): the control plane now
 * reads MOCA_TENANCY too, and two copies of `isTenancyNearMiss` would be two near-miss policies.
 * This file stays so `server-process.ts`'s import, and the tests pinned to it, are unchanged.
 */
export { isTenancyNearMiss, readTenancy, type Tenancy } from '@moca/control-plane';
