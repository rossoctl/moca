/**
 * The deployment's version, advertised to clients so they can show it. MOCA_VERSION wins — the
 * image build bakes in the git tag it was built from (Dockerfile ARG). Unset means a from-source
 * run, reported as `dev`: no package.json read, because a bundled release asset ships none.
 */
export function resolveVersion(env: NodeJS.ProcessEnv): string {
  return env.MOCA_VERSION || 'dev';
}
