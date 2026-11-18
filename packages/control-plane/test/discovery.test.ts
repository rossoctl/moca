import { describe, expect, it } from 'vitest';
import { HANDLERS, type CpConfig } from '../src/handlers.js';
import { ctx, makeDeps } from './helpers/deps.js';

describe('GET /v1/discovery', () => {
  it('advertises the configured harness URL', async () => {
    const d = makeDeps({ config: { publicHarnessUrl: 'https://harness.example.com' } });
    expect(await HANDLERS.getDiscovery!(ctx({}), d)).toEqual({
      status: 200,
      body: {
        harnessUrl: 'https://harness.example.com',
        sandboxTiers: null,
        version: null,
        profile: 'harness',
      },
    });
  });

  it('answers null rather than 404 when the deployment advertises none', async () => {
    // A 404 is how a client recognises a control plane that predates discovery; null is a
    // deployment that has it but was not given SH_PUBLIC_HARNESS_URL. They need different fixes.
    expect(await HANDLERS.getDiscovery!(ctx({}), makeDeps())).toEqual({
      status: 200,
      body: { harnessUrl: null, sandboxTiers: null, version: null, profile: 'harness' },
    });
  });

  it('advertises the declared sandbox tiers and the default (P6.3)', async () => {
    const d = makeDeps({
      config: { sandboxTiers: { names: ['container', 'microvm'], default: 'container' } },
    });
    expect((await HANDLERS.getDiscovery!(ctx({}), d)).body).toEqual({
      harnessUrl: null,
      sandboxTiers: { names: ['container', 'microvm'], default: 'container' },
      version: null,
      profile: 'harness',
    });
  });

  it('advertises the deployment version for client banners', async () => {
    const d = makeDeps({
      config: { publicHarnessUrl: 'https://harness.example.com', version: '0.5.2' },
    });
    expect(await HANDLERS.getDiscovery!(ctx({}), d)).toEqual({
      status: 200,
      body: {
        harnessUrl: 'https://harness.example.com',
        sandboxTiers: null,
        version: '0.5.2',
        profile: 'harness',
      },
    });
  });

  it('answers both sets of fields on the combined profile (combined control plane spec §3.1)', async () => {
    const base = makeDeps().config.sandbox!;
    const d = makeDeps({
      config: {
        routeProfile: 'combined',
        publicHarnessUrl: 'https://harness.example.com',
        sandbox: { ...base, execEndpoint: 'sbx-exec.example.invalid:443' },
      },
    });
    expect((await HANDLERS.getDiscovery!(ctx({}), d)).body).toEqual({
      harnessUrl: 'https://harness.example.com',
      sandboxTiers: null,
      version: null,
      profile: 'combined',
      execEndpoint: 'sbx-exec.example.invalid:443',
    });
  });
});

// #779: the control plane's own URL, opened in a browser or with curl, said `{"error":"not_found"}`,
// which told a user nothing about what they had reached or what to do next.
describe('GET / (#779)', () => {
  const page = async (config: Partial<CpConfig> = {}) => {
    const r = await HANDLERS.getIndex!(ctx({}), makeDeps({ config }));
    expect(r.status).toBe(200);
    expect(r.contentType).toBe('text/plain; charset=utf-8');
    return r.body as string;
  };

  it('says what it is, where the API is, how to get mocactl and whom to ask for egress', async () => {
    const body = await page();
    expect(body).toMatch(/^This is a Moca control plane\./);
    expect(body).toContain('GET /v1/discovery');
    expect(body).toContain('scripts/install-mocactl.sh');
    expect(body).toContain('SH_CONTROL_PLANE_URL=<this URL> mocactl login');
    expect(body).toContain('403 destination_denied');
    expect(body).toContain('ask the operator of this deployment');
    // The harness profile has no `mocactl sbx` routes: its page does not send anyone there.
    expect(body).not.toContain('mocactl sbx');
  });

  it('points a sandbox-service user at `mocactl sbx login` and its guide', async () => {
    const base = makeDeps().config.sandbox!;
    const body = await page({ routeProfile: 'sandbox', sandbox: base });
    expect(body).toMatch(/^This is a Moca control plane \(the sandbox service\)\./);
    expect(body).toContain('mocactl sbx login --control-plane-url <this URL>');
    expect(body).toContain('docs/sandbox/user-guide.md');
    expect(body).not.toContain('SH_CONTROL_PLANE_URL');
  });

  it('names both clients on the combined profile', async () => {
    const base = makeDeps().config.sandbox!;
    const body = await page({ routeProfile: 'combined', sandbox: base });
    expect(body).toContain('mocactl sbx login --control-plane-url <this URL>');
    expect(body).toContain('SH_CONTROL_PLANE_URL=<this URL> mocactl login');
  });

  it('names the deployment version when it has one, and no URL of the deployment', async () => {
    expect(await page({ version: '0.5.2' })).toContain('version 0.5.2');
    expect(await page()).not.toContain('version');
    // Nothing deployment-specific: no configured URL, so a page cached or pasted anywhere is safe.
    const body = await page({ publicHarnessUrl: 'https://harness.example.com' });
    expect(body).not.toContain('harness.example.com');
  });
});
