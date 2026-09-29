import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createClient } from 'redis';
import {
  buildBundle,
  hasErrors,
  renderPreflight,
  serializeLockfile,
  SecretScanError,
} from '@moca/config-bundle';
import { putBundle, type BundleRedisLike } from './config-store.js';
import {
  LOCKFILE_OUT,
  parsePromoteArgs,
  promoteInputs,
  readInventory,
  resolveHomeDir,
  resolveInventoryPath,
  resolveProjectDir,
} from './promote.js';

/** Write the lockfile to the filesystem. */
function writeLockfile(cwd: string, lockfile: ReturnType<typeof serializeLockfile>): void {
  const lockPath = join(cwd, LOCKFILE_OUT);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, lockfile);
}

async function main(): Promise<void> {
  const args = parsePromoteArgs(process.argv.slice(2));
  // `--project` names the project being promoted; without it, promote reads whatever directory
  // the process happens to be started from -- which, run via `pnpm promote` from `harness/`, is
  // the harness checkout itself, not the caller's project. That silently bundled the harness's
  // own CLAUDE.md and zero memory. Fail loudly rather than promote the wrong thing.
  const cwd = resolveProjectDir(args, process.cwd());
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    console.error(`promote aborted: project directory does not exist: ${cwd}`);
    process.exit(1);
  }
  console.log(`project:    ${cwd}`);
  // Which directory is being read as USER scope decides what travels, so print it rather than
  // leaving the caller to infer it from an env var they cannot see in the transcript.
  const home = resolveHomeDir(args, homedir());
  const homeSource = args.home === undefined ? '($HOME)' : '(--home)';
  // Guarded exactly like --project above, and for the same reason. A directory that does not exist
  // resolves no skills and no prompts, so promote builds an empty bundle and then aborts as
  // `unknown_entry: entry prompt '<x>' is not in the bundle (available: none)` -- measured. That
  // names the symptom rather than the path the caller mistyped, which is the failure mode
  // preflight.ts:225-226 already rejects for the same reason.
  if (!existsSync(home) || !statSync(home).isDirectory()) {
    console.error(`promote aborted: user scope directory does not exist: ${home} ${homeSource}`);
    process.exit(1);
  }
  console.log(`user scope: ${home} ${homeSource}`);

  const inventoryPath = resolveInventoryPath(args.sandboxImage, cwd);
  const inventory = readInventory(args.sandboxImage, cwd);
  // Say which inventory was used. Module-relative outranks cwd-local, so a caller who dropped a
  // deliberate override beside their project must be able to see that it was not the one read.
  console.log(
    inventoryPath === undefined
      ? `inventory:  none for ${args.sandboxImage} — the binary check will warn, not verify`
      : `inventory:  ${inventoryPath} (${inventory?.length ?? 0} binaries)`,
  );

  const result = buildBundle(
    promoteInputs({
      cwd,
      home,
      args,
      ...(inventory ? { inventory } : {}),
      versions: {
        pi: process.env.SH_PI_VERSION ?? 'unknown',
        harness: process.env.SH_HARNESS_VERSION ?? '0.0.0',
      },
    }),
  );

  console.log(
    `  resolved   ${result.lockfile.skills.length + result.lockfile.dropped.length} skills`,
  );
  console.log(`  travels    ${result.lockfile.skills.length}`);
  console.log(`  dropped    ${result.lockfile.dropped.length}`);
  for (const d of result.lockfile.dropped) console.log(`             ${d.name}  (${d.reason})`);
  console.log(
    `  context    ${result.lockfile.context.length} file(s), ${result.lockfile.memory.length} memory file(s)`,
  );
  const secretWarnings = result.findings.filter((f) => f.code === 'possible_secret');
  console.log(
    `  secrets    no blocking findings` +
      (secretWarnings.length ? `, ${secretWarnings.length} warning(s) — see below` : ''),
  );
  console.log(`  entry      ${result.lockfile.entry}`);
  console.log('');
  console.log(renderPreflight(result.findings));
  console.log('');

  if (hasErrors(result.findings)) {
    console.error('promote aborted: preflight found errors (see above)');
    process.exit(2);
  }

  if (args.dryRun) {
    console.log(
      `  bundle     ${result.digest}  (${result.tar.length} bytes, --dry-run: not uploaded)`,
    );
    console.log(`  lockfile   ${LOCKFILE_OUT}  (--dry-run: not written)`);
    return;
  }

  const client = createClient({ url: args.redisUrl ?? process.env.REDIS_URL });
  await client.connect();
  try {
    const { uploaded } = await putBundle(
      client as unknown as BundleRedisLike,
      result.digest,
      result.tar,
    );
    writeLockfile(cwd, serializeLockfile(result.lockfile));
    console.log(
      `  bundle     ${result.digest}  (${result.tar.length} bytes, ${uploaded ? 'uploaded' : 'unchanged — upload skipped'})`,
    );
    console.log(`  lockfile   ${LOCKFILE_OUT}`);
    console.log('');
    console.log(
      `dispatch with:  {"sessionId":"<run>/<item>","kind":"prompt","prompt":"…","configRef":"${result.digest}"}`,
    );
  } finally {
    await client.quit();
  }
}

main().catch((err) => {
  if (err instanceof SecretScanError) {
    // Only structural credential formats reach here; heuristic hits are warnings in the report.
    console.error(`promote BLOCKED — ${err.message}`);
    for (const f of err.findings) console.error(`  ${f.path}:${f.line}  ${f.rule}`);
    console.error('\nRemove the credential or add the file to your deny-list, then re-run.');
    process.exit(3);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
