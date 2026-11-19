import { afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';

// Every git a test starts (its own, the code under test's, a fake workspace's bash) inherits this
// environment: without the host's system and global config, no host hook or signing runs on a
// test's commits.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';

// ink-testing-library's `render()` pushes every Ink instance into a module-level array that
// only its own `cleanup()` drains — nothing does that automatically. Without this, a render
// left mounted at the end of a test (its interval timers, in-flight AbortControllers, and
// input listeners all still live) survives into every later test in the same worker process,
// for the rest of the suite. Unmounting after each test keeps that from accumulating.
afterEach(() => {
  cleanup();
});
