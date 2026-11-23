import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CpError } from '../src/errors.js';
import {
  CREDENTIAL_NAME_RE,
  InMemoryCredentialStore,
  kindSpec,
  parseCredentialBody,
  registerKind,
  unregisterKind,
  resolveInferenceName,
  validateCredentialName,
  type CredentialDescriptor,
  type StoredCredential,
} from '../src/credential-store.js';

const bearerBody = (over: Record<string, unknown> = {}) => ({
  kind: 'bearer',
  consumer: 'sandbox-egress',
  destination: { hosts: ['api.github.com'] },
  binding: { header: 'Authorization', format: 'Bearer {token}' },
  secret: { token: 'ghp-fake' }, // notsecret
  ...over,
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as CpError).code;
  }
  throw new Error('expected a throw');
};

describe('credential names', () => {
  it('accepts DNS-label-ish names, so github-work and github-personal coexist', () => {
    for (const ok of ['github-work', 'github-personal', 'my-anthropic', 'a', 'a1-2-3']) {
      expect(validateCredentialName(ok), ok).toBe(ok);
    }
  });

  it('rejects a name containing the AAD delimiter', () => {
    // Load-bearing for envelope.ts: the AAD is the plain `subject|name` of spec §6.5, which is only
    // unambiguous while neither half can contain a `|`. Loosen this charset and two different
    // (subject, name) pairs can produce one AAD.
    expect(codeOf(() => validateCredentialName('a|b'))).toBe('invalid_request');
  });

  it('rejects names a Kubernetes Secret data key would refuse, and path tricks', () => {
    for (const bad of [
      '',
      'A-Upper',
      'has space',
      '-leading',
      'trailing-',
      'a/b',
      '../escape',
      'x'.repeat(41),
    ]) {
      expect(
        codeOf(() => validateCredentialName(bad)),
        bad,
      ).toBe('invalid_request');
    }
  });

  it('exports the pattern it enforces, so the OpenAPI document can state the same one', () => {
    expect(CREDENTIAL_NAME_RE.test('github-work')).toBe(true);
    expect(CREDENTIAL_NAME_RE.test('Github_Work')).toBe(false);
  });
});

describe('the kind registry', () => {
  // registerKind mutates a MODULE-level map, so without this every test after the sigv4 one below runs
  // against a registry the file itself widened -- including "rejects an unregistered kind", which would
  // then be asserting about a registry state no deployment has.
  const BUILTIN = ['bearer', 'basic', 'api-key', 'oauth2-token'];
  afterEach(() => {
    unregisterKind('sigv4');
    // The built-ins must still be there: this restores the ADDED kind, it does not reset the map.
    for (const k of BUILTIN) expect(() => kindSpec(k), k).not.toThrow();
  });

  it('knows the slice-1 kinds', () => {
    for (const kind of ['bearer', 'basic', 'api-key', 'oauth2-token']) {
      expect(kindSpec(kind).secretFields.length, kind).toBeGreaterThan(0);
    }
  });

  it('is a registry, not a closed union: a new kind is an addition, not a migration', () => {
    registerKind('sigv4', {
      secretFields: ['accessKeyId', 'secretAccessKey'],
      defaultBinding: { header: 'Authorization', format: 'AWS4-HMAC-SHA256 {accessKeyId}' },
    });
    expect(kindSpec('sigv4').secretFields).toEqual(['accessKeyId', 'secretAccessKey']);
    expect(
      parseCredentialBody('aws', {
        ...bearerBody(),
        kind: 'sigv4',
        binding: { header: 'Authorization', format: 'AWS4-HMAC-SHA256 {accessKeyId}' },
        secret: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' }, // notsecret
      }).descriptor.kind,
    ).toBe('sigv4');
  });

  it('and the afterEach really un-registers it, so the widening does not leak', () => {
    // Runs after the sigv4 test in declaration order, so a working restore makes this the state a
    // fresh process would see.
    expect(() => kindSpec('sigv4')).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(unregisterKind('sigv4')).toBe(false); // already gone, not merely absent-by-luck
  });

  it('rejects an unregistered kind', () => {
    expect(codeOf(() => parseCredentialBody('x', bearerBody({ kind: 'telepathy' })))).toBe(
      'invalid_request',
    );
  });

  it('supplies the kind default binding when the body omits one', () => {
    const parsed = parseCredentialBody('x', bearerBody({ binding: undefined }));
    expect(parsed.descriptor.binding).toEqual(kindSpec('bearer').defaultBinding);
  });
});

describe("consumer: 'control-plane', the third member of the union", () => {
  // Zero coverage until now: only 'inference' and 'sandbox-egress' were exercised, so nothing proved
  // the third member is accepted at all -- or that it is NOT subject to the inference-only rules.
  const cpBody = (over: Record<string, unknown> = {}) =>
    bearerBody({ consumer: 'control-plane', ...over });

  it('is accepted and survives into the descriptor verbatim', () => {
    expect(parseCredentialBody('gh-app', cpBody()).descriptor.consumer).toBe('control-plane');
  });

  it('is rejected an endpoint, which is inference-only', () => {
    // endpoint means "where inference goes"; accepting it here would create a second, silently
    // ignored notion of destination alongside destination.hosts.
    expect(codeOf(() => parseCredentialBody('gh-app', cpBody({ endpoint: 'https://x/v1' })))).toBe(
      'invalid_request',
    );
  });

  it('is NOT held to the single-secret-field rule that inference imposes', () => {
    // 'basic' declares two secret fields, which inference refuses because a two-field kind cannot
    // become one Bearer. That restriction is about inference specifically, not about every consumer.
    expect(
      parseCredentialBody('gh-basic', {
        ...cpBody(),
        kind: 'basic',
        binding: { header: 'Authorization', format: 'Basic {username}' },
        secret: { username: 'u', password: 'p' }, // notsecret
      }).descriptor.kind,
    ).toBe('basic');
  });

  it('is not resolvable as an inference credential', () => {
    // resolveInferenceName must ignore it: a control-plane credential is not a thing a turn can run on.
    const descriptors = [
      parseCredentialBody('gh-app', cpBody()).descriptor,
    ] as CredentialDescriptor[];
    expect(codeOf(() => resolveInferenceName(descriptors, undefined))).toBe('credential_required');
  });
});

describe('parseCredentialBody', () => {
  it('parses a well-formed sandbox-egress bearer', () => {
    const parsed = parseCredentialBody('github-work', bearerBody());
    expect(parsed.descriptor).toEqual({
      name: 'github-work',
      kind: 'bearer',
      consumer: 'sandbox-egress',
      destination: { hosts: ['api.github.com'] },
      binding: { header: 'Authorization', format: 'Bearer {token}' },
      endpoint: null,
    });
    expect(parsed.secret).toEqual({ token: 'ghp-fake' }); // notsecret
  });

  it('requires exactly the secret fields the kind declares', () => {
    expect(codeOf(() => parseCredentialBody('x', bearerBody({ secret: {} })))).toBe(
      'invalid_request',
    );
    // An UNDECLARED extra field is rejected rather than stored: a typo'd field name would otherwise
    // be silently persisted and the credential would fail at use time with nothing to point at.
    expect(
      codeOf(() => parseCredentialBody('x', bearerBody({ secret: { token: 'a', tokn: 'b' } }))),
    ).toBe('invalid_request');
    expect(codeOf(() => parseCredentialBody('x', bearerBody({ secret: { token: 42 } })))).toBe(
      'invalid_request',
    );
    expect(codeOf(() => parseCredentialBody('x', bearerBody({ secret: { token: '' } })))).toBe(
      'invalid_request',
    );
  });

  it('requires a non-empty destination host allow-list', () => {
    // Recorded in slice 1 even though nothing enforces it yet: it is the input slice 3's forward
    // proxy needs, so users do not have to re-declare it later (spec §6.3).
    expect(codeOf(() => parseCredentialBody('x', bearerBody({ destination: { hosts: [] } })))).toBe(
      'invalid_request',
    );
    expect(codeOf(() => parseCredentialBody('x', bearerBody({ destination: undefined })))).toBe(
      'invalid_request',
    );
    expect(
      codeOf(() =>
        parseCredentialBody('x', bearerBody({ destination: { hosts: ['https://a/b'] } })),
      ),
    ).toBe('invalid_request');
  });

  it('rejects an unknown consumer tier', () => {
    expect(codeOf(() => parseCredentialBody('x', bearerBody({ consumer: 'sandbox' })))).toBe(
      'invalid_request',
    );
  });

  it('refuses a multi-secret-field kind for consumer: inference', () => {
    // The exchange delivers an inference credential as ONE Bearer token and reads the kind's single
    // secret field. `basic` has two (username, password), so accepting it here would send the
    // USERNAME upstream as the bearer -- a misdirected secret. Caught at write time instead.
    expect(
      codeOf(() =>
        parseCredentialBody('x', {
          kind: 'basic',
          consumer: 'inference',
          destination: { hosts: ['gw.internal'] },
          secret: { username: 'alice', password: 'pw' }, // notsecret
        }),
      ),
    ).toBe('invalid_request');
    // The same kind is fine for a consumer whose delivery is not a single bearer.
    expect(
      parseCredentialBody('x', {
        kind: 'basic',
        consumer: 'sandbox-egress',
        destination: { hosts: ['gw.internal'] },
        secret: { username: 'alice', password: 'pw' }, // notsecret
      }).descriptor.kind,
    ).toBe('basic');
  });

  it('keeps every single-field kind usable for inference', () => {
    for (const [kind, secret] of [
      ['bearer', { token: 'sk-fake' }], // notsecret
      ['api-key', { key: 'sk-fake' }], // notsecret
      ['oauth2-token', { accessToken: 'sk-fake' }], // notsecret
    ] as const) {
      expect(
        parseCredentialBody('x', {
          kind,
          consumer: 'inference',
          destination: { hosts: ['gw.internal'] },
          secret,
        }).descriptor.kind,
        kind,
      ).toBe(kind);
    }
  });

  it('accepts endpoint only for consumer: inference', () => {
    // `destination.hosts` is a host ALLOW-LIST, not a base URL, so it cannot serve as the gateway
    // address applyModelGateway needs -- hence a separate `endpoint` (spec §6.2).
    const inf = parseCredentialBody(
      'my-anthropic',
      bearerBody({ consumer: 'inference', endpoint: 'https://litellm.internal/v1' }),
    );
    expect(inf.descriptor.endpoint).toBe('https://litellm.internal/v1');
    expect(
      codeOf(() =>
        parseCredentialBody('x', bearerBody({ consumer: 'sandbox-egress', endpoint: 'https://a' })),
      ),
    ).toBe('invalid_request');
  });

  it('rejects a non-absolute-origin endpoint', () => {
    expect(
      codeOf(() =>
        parseCredentialBody('x', bearerBody({ consumer: 'inference', endpoint: 'litellm/v1' })),
      ),
    ).toBe('invalid_request');
  });

  // PR #540 review R3: defence in depth -- the endpoint is the user's, and every catalog call and
  // exchange parses it; no real gateway URL is near 2048 characters.
  it('refuses an endpoint over 2048 characters', () => {
    const at = (n: number) =>
      `https://litellm.internal/${'v'.repeat(n - 'https://litellm.internal/'.length)}`;
    expect(
      parseCredentialBody('x', bearerBody({ consumer: 'inference', endpoint: at(2048) })).descriptor
        .endpoint,
    ).toHaveLength(2048);
    expect(
      codeOf(() =>
        parseCredentialBody('x', bearerBody({ consumer: 'inference', endpoint: at(2049) })),
      ),
    ).toBe('invalid_request');
  });

  it('defaults endpoint to null rather than undefined', () => {
    expect(
      parseCredentialBody('x', bearerBody({ consumer: 'inference' })).descriptor.endpoint,
    ).toBe(null);
  });

  it('rejects a non-object body', () => {
    for (const bad of [null, 'string', 42, []]) {
      expect(
        codeOf(() => parseCredentialBody('x', bad)),
        String(bad),
      ).toBe('invalid_request');
    }
  });
});

describe('sandbox-egress destination and default-binding validation', () => {
  afterEach(() => {
    unregisterKind('badkind');
  });

  it('accepts 16 destinations and refuses 17', () => {
    const hosts = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`);
    expect(
      parseCredentialBody('x', bearerBody({ destination: { hosts: hosts(16) } })).descriptor
        .destination.hosts,
    ).toHaveLength(16);
    expect(
      codeOf(() => parseCredentialBody('x', bearerBody({ destination: { hosts: hosts(17) } }))),
    ).toBe('invalid_request');
  });

  it.each([[['GitHub.com', 'github.com.']], [['h:443', 'h']]])(
    'refuses destinations that are duplicates after normalization: %j',
    (hosts) => {
      expect(codeOf(() => parseCredentialBody('x', bearerBody({ destination: { hosts } })))).toBe(
        'invalid_request',
      );
    },
  );

  it('validates the kind default binding for sandbox-egress only', () => {
    registerKind('badkind', {
      secretFields: ['token'],
      defaultBinding: { header: 'Authorization', format: 'Bearer {nope}' },
    });
    const body = bearerBody({ kind: 'badkind', binding: undefined });
    expect(codeOf(() => parseCredentialBody('x', body))).toBe('invalid_request');
    expect(
      parseCredentialBody('x', { ...body, consumer: 'control-plane' }).descriptor.consumer,
    ).toBe('control-plane');
  });
});

describe('resolveInferenceName', () => {
  const desc = (name: string, consumer = 'inference'): CredentialDescriptor => ({
    name,
    kind: 'bearer',
    consumer: consumer as CredentialDescriptor['consumer'],
    destination: { hosts: ['api.anthropic.com'] },
    binding: { header: 'Authorization', format: 'Bearer {token}' },
    endpoint: null,
  });

  it('resolves the single inference credential when none is named', () => {
    expect(resolveInferenceName([desc('my-anthropic'), desc('gh', 'sandbox-egress')])).toBe(
      'my-anthropic',
    );
  });

  it('refuses to pick silently when the owner has several', () => {
    expect(codeOf(() => resolveInferenceName([desc('a'), desc('b')]))).toBe('credential_ambiguous');
  });

  it('honours an explicit name', () => {
    expect(resolveInferenceName([desc('a'), desc('b')], 'b')).toBe('b');
  });

  it('fails at session creation, not three turns in, when the owner has none', () => {
    expect(codeOf(() => resolveInferenceName([desc('gh', 'sandbox-egress')]))).toBe(
      'credential_required',
    );
    expect(codeOf(() => resolveInferenceName([]))).toBe('credential_required');
  });

  it('404s a named credential that does not exist', () => {
    expect(codeOf(() => resolveInferenceName([desc('a')], 'nope'))).toBe('credential_not_found');
  });

  it('refuses a named credential that is not an inference one', () => {
    expect(codeOf(() => resolveInferenceName([desc('gh', 'sandbox-egress')], 'gh'))).toBe(
      'invalid_request',
    );
    // The text is what the user sees: it names the credential and the consumer it does have.
    expect(() => resolveInferenceName([desc('gh', 'sandbox-egress')], 'gh')).toThrow(
      "credential 'gh' has consumer 'sandbox-egress', not 'inference'",
    );
  });
});

describe('InMemoryCredentialStore', () => {
  let store: InMemoryCredentialStore;
  const cred = (name: string): StoredCredential => parseCredentialBody(name, bearerBody());

  beforeEach(() => {
    store = new InMemoryCredentialStore();
  });

  it('round-trips put/get for one subject', async () => {
    await store.put('github:1', cred('github-work'));
    expect((await store.get('github:1', 'github-work'))?.secret).toEqual({ token: 'ghp-fake' }); // notsecret
  });

  it('keeps subjects apart', async () => {
    await store.put('github:1', cred('github-work'));
    expect(await store.get('github:2', 'github-work')).toBeNull();
    expect(await store.list('github:2')).toEqual([]);
  });

  it('lists descriptors only -- no secret material', async () => {
    await store.put('github:1', cred('github-work'));
    const listed = await store.list('github:1');
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('ghp-fake');
    expect(Object.keys(listed[0]!)).not.toContain('secret');
  });

  it('overwrites on re-put and deletes idempotently', async () => {
    await store.put('github:1', cred('github-work'));
    await store.put('github:1', {
      ...cred('github-work'),
      secret: { token: 'ghp-rotated' }, // notsecret
    });
    expect((await store.get('github:1', 'github-work'))?.secret.token).toBe('ghp-rotated'); // notsecret
    await store.delete('github:1', 'github-work');
    await store.delete('github:1', 'github-work'); // no throw on a second delete
    expect(await store.get('github:1', 'github-work')).toBeNull();
  });

  it('returns null for an unknown name rather than throwing', async () => {
    expect(await store.get('github:1', 'nope')).toBeNull();
  });
});

describe('the hmac-sha256 kind (#394)', () => {
  it('takes one `key` field and declares the signature header it travels in', () => {
    const spec = kindSpec('hmac-sha256');
    expect(spec.secretFields).toEqual(['key']);
    expect(spec.defaultBinding).toEqual({ header: 'X-Moca-Signature', format: 'sha256={hmac}' });
  });

  it('round-trips through the in-memory store under the control-plane consumer', async () => {
    const store = new InMemoryCredentialStore();
    await store.put('github:1234', {
      descriptor: {
        name: 'notify-webhook',
        kind: 'hmac-sha256',
        consumer: 'control-plane',
        destination: { hosts: ['hooks.example.com'] },
        binding: kindSpec('hmac-sha256').defaultBinding,
        endpoint: null,
      },
      secret: { key: 'ab'.repeat(32) },
    });
    expect((await store.get('github:1234', 'notify-webhook'))?.secret.key).toBe('ab'.repeat(32));
    expect((await store.list('github:1234')).map((d) => d.kind)).toContain('hmac-sha256');
  });
});
