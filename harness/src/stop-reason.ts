/**
 * The abort REASON that means "this turn ran out of its wall clock" (#391), as opposed to "somebody
 * cancelled it". The async worker's watchdog passes it to `AbortController.abort`; `run-leaf` maps
 * it to `failed: budget` and every other reason to `aborted`, which finalizes as `cancelled`.
 *
 * Its own module so the two ends of that protocol import one constant rather than agreeing on a
 * string literal twice -- and so the worker loop does not have to load `run-leaf`'s whole import
 * graph (pi, the sandbox transports) to know it.
 */
export const DEADLINE_ABORT = 'deadline';
