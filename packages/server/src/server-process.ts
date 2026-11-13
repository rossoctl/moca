import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AMBIENT_KEY_SENTINEL } from '@moca/harness/ambient-sentinel';
import { credentialValue } from '@moca/control-plane';
import { assertKeysetUsable } from './turn-auth.js';
import { readTenancy, type Tenancy } from './tenancy.js';

// Created once per process: every turn in this process shares it, no other process does.
let privateAgentDir: string | undefined;

function ensurePrivateAgentDir(): string {
  if (!privateAgentDir) privateAgentDir = mkdtempSync(join(tmpdir(), 'sh-agent-')); // mode 0700
  return privateAgentDir;
}

/**
 * Every environment variable pi reads a provider credential from, by shape: its per-provider API
 * keys and tokens (`*_API_KEY`, `*_AUTH_TOKEN`, `*_OAUTH_TOKEN`, `HF_TOKEN`, `COPILOT_GITHUB_TOKEN`),
 * Bedrock's AWS credential sources, and Vertex's application-default credentials
 * (pi-ai `env-api-keys.ts`). By shape rather than by name, so a provider pi adds later is covered
 * without this list changing; `server-process.test.ts` checks it against pi's own lookup.
 */
const PROVIDER_CREDENTIAL =
  /(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN)$|^(HF_TOKEN|COPILOT_GITHUB_TOKEN|GOOGLE_APPLICATION_CREDENTIALS)$|^AWS_(PROFILE|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN_BEDROCK|CONTAINER_CREDENTIALS_RELATIVE_URI|CONTAINER_CREDENTIALS_FULL_URI|WEB_IDENTITY_TOKEN_FILE)$/;

/**
 * P5 §3.2 step 3, applied only under multi tenancy (MI1 §5 R2): the process holds no provider
 * credential. Every variable pi could read one from is deleted, for every provider -- a `/runs`
 * envelope names its own provider and model, so scrubbing only Anthropic's and OpenAI's would leave
 * a caller free to spend any other ambient key. ANTHROPIC_API_KEY then becomes the sentinel (pi
 * requires it to exist); the OAuth token must be gone because pi's lookup ranks it above
 * ANTHROPIC_API_KEY, so leaving it would defeat the sentinel.
 */
export function scrubAmbientCredentials(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (PROVIDER_CREDENTIAL.test(name)) delete env[name];
  }
  env.ANTHROPIC_API_KEY = AMBIENT_KEY_SENTINEL;
}

/**
 * Boot-time preparation shared by every server entry point — `startServer()` and the P6 worker —
 * so none can run unprepared (MI1 §5 R2, P6 §3.6). Throws on an
 * inconsistent configuration; callers turn that into a boot failure.
 */
export function prepareServerProcess(env: NodeJS.ProcessEnv = process.env): {
  tenancy: Tenancy;
  agentDir: string;
} {
  assertKeysetUsable(env);
  // Resolved here once so a both-set or empty SH_EXCHANGE_TOKEN credential fails the BOOT, not the
  // first authenticated turn; turnAuthDepsFromEnv re-reads it per request (it is never cached).
  credentialValue(env, 'SH_EXCHANGE_TOKEN');
  const tenancy = readTenancy(env);
  if (tenancy === 'multi') {
    if (env.SH_LOCAL_TOOLS === '1') {
      throw new Error('MOCA_TENANCY=multi refuses SH_LOCAL_TOOLS=1: tools must run in a sandbox');
    }
    if (env.SH_REQUIRE_AUTH !== 'true') {
      throw new Error('MOCA_TENANCY=multi requires SH_REQUIRE_AUTH=true');
    }
    scrubAmbientCredentials(env);
  }
  // Pi reads SYSTEM.md, extensions/, skills/, auth.json and models.json from the agent directory. A
  // server never uses a shared one — not $HOME/.pi/agent, not an inherited value (MI1 §5 R4).
  env.PI_CODING_AGENT_DIR = ensurePrivateAgentDir();
  return { tenancy, agentDir: env.PI_CODING_AGENT_DIR };
}
