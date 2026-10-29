import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import { DnsProviders } from '../services/dns/DnsProviders.js';
import { dnsProvidersRouter } from './dns-providers.js';

let harness: Harness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

describe('/api/dns-providers', () => {
  it('describes each DNS provider the registry has, its fields and how to set it up, and no secret', async () => {
    harness = await mountRouter({ prefix: '/api/dns-providers', router: () => dnsProvidersRouter({ dns: new DnsProviders() }) });
    const answer = await axios.get(harness.url('/api/dns-providers'));
    expect(answer.data.map((provider: { name: string }) => provider.name)).toEqual(['cloudflare', 'porkbun']);
    const porkbun = answer.data.find((provider: { name: string }) => provider.name === 'porkbun');
    expect(porkbun).toMatchObject({ label: 'Porkbun DNS', setup: expect.stringContaining('API Access') });
    expect(porkbun.fields).toEqual([
      { key: 'apiKey', label: 'API Key', secret: true, placeholder: 'pk1_…', optional: false },
      { key: 'secretApiKey', label: 'Secret API Key', secret: true, placeholder: 'sk1_…', optional: false },
    ]);
    expect(JSON.stringify(answer.data)).not.toMatch(/env|PORKBUN_API|CLOUDFLARE_API/);
  });
});
