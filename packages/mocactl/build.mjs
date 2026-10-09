// Bundles mocactl and every runtime dependency into one file the user's own Node 22 runs: the
// release asset scripts/install-mocactl.sh installs (docs/specs/2026-10-08-mocactl-installer-design.md
// §4). bin/mocactl.mjs, the tsx path from a checkout, does not use it.
//
//   node build.mjs [--outfile PATH] [--entry PATH]      (pnpm --filter @moca/mocactl build)
//
// The version comes from MOCACTL_VERSION in the environment (the release workflow sets it), else `dev`.
// --entry exists for test/bundle.test.ts, which bundles a probe with these exact options.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const { values } = parseArgs({
  options: { outfile: { type: 'string' }, entry: { type: 'string' } },
});

await build({
  entryPoints: [values.entry ?? here('src/main.ts')],
  outfile: values.outfile ?? here('dist/mocactl.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  jsx: 'automatic',
  tsconfig: here('tsconfig.json'),
  define: { MOCACTL_VERSION: JSON.stringify(process.env.MOCACTL_VERSION || 'dev') },
  alias: { 'react-devtools-core': here('build/react-devtools-stub.mjs') },
  // The shebang lets the installer run the file as `mocactl`. The `require` is for bundled CommonJS
  // (signal-exit, via Ink) that requires Node built-ins: esbuild's ESM output has no `require`, and
  // without one the TUI dies at startup with `Dynamic require of "assert" is not supported`.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __mocactlCreateRequire } from 'node:module';",
      'const require = __mocactlCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'warning',
});
