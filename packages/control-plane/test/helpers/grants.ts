import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mintGrants } from '../../src/grant.js';
import { HANDLERS, type CpDeps } from '../../src/handlers.js';
import { makeSigner, publicKeyFromBase64 } from '../../src/token.js';
import { alice, ctx, makeDeps, type TestDeps } from './deps.js';

/**
 * The grant ring, generated per call for the reason `makeDeps` gives about its own signer: a
 * committed Ed25519 private key would be a gitleaks finding on the blob. Separate from `deps.signer`
 * on purpose -- that separation is the §6.1 property these suites exercise.
 */
export function grantRing(): {
  grantSigner: ReturnType<typeof makeSigner>;
  grantVerifyKeys: Map<string, KeyObject>;
} {
  const { privateKey } = generateKeyPairSync('ed25519');
  const grantSigner = makeSigner(
    privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    'MOCA_GRANT_SIGNING_KEY',
  );
  return {
    grantSigner,
    grantVerifyKeys: new Map([[grantSigner.kid, publicKeyFromBase64(grantSigner.publicKeyBase64)]]),
  };
}

export function grantDeps(over: Parameters<typeof makeDeps>[0] = {}): TestDeps {
  return makeDeps({ ...grantRing(), ...over });
}

/** Create a session through the real handler, owned by alice, with the fixed id 'sid-fixed'. */
export async function seedSession(d: CpDeps, id = 'sid-fixed'): Promise<void> {
  await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), { ...d, newId: () => id });
}

/** Tombstone a session the way `turn-exchange.test.ts`'s tombstone case does. */
export async function tombstone(d: CpDeps, sid: string): Promise<void> {
  await d.index.tombstone(sid);
}

/** The pair a dequeue would mint for alice's session, with the knobs each test needs. */
export function mint(d: TestDeps, over: Partial<Parameters<typeof mintGrants>[1]> = {}) {
  const nowS = Math.floor(d.now() / 1000);
  return mintGrants(d.grantSigner!, {
    sub: 'github:1234',
    tenant: 'default',
    sid: 'sid-fixed',
    cred: 'my-anthropic',
    egress: [],
    ttlSeconds: 1800,
    turnExp: nowS + 1800,
    now: nowS,
    ...over,
  });
}
