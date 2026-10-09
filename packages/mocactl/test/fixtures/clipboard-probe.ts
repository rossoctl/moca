// Bundled by test/bundle.test.ts with build.mjs's own options, then run with no clipboard tool on
// PATH. In a bundle, clipboardy's own fallback xsel is not on disk either, so a copy must REJECT
// (app.tsx turns that into "copy failed: …"), never crash the process. Spec §4.
import clipboard from 'clipboardy';

clipboard.write('probe').then(
  () => console.log('written'),
  (err: Error) => console.log(`rejected: ${err.message}`),
);
