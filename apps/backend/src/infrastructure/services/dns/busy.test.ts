import { describe, expect, it } from 'vitest';
import { failureOf } from '../../../platform/index.js';
import { cloudflareProvider } from './cloudflare.js';
import { porkbunProvider } from './porkbun.js';

const answering = (status: number, body: unknown) => (async () => Response.json(body, { status })) as typeof fetch;
const PORKBUN = { apiKey: 'pk1_x', secretApiKey: 'sk1_x' };

describe('a DNS provider that is busy or failing', () => {
  it('is a failure Koala tries again, never credentials it calls wrong', async () => {
    for (const status of [429, 500, 503]) {
      const cloudflare = cloudflareProvider(answering(status, { success: false, errors: [{ message: 'busy' }] }));
      const busy = await cloudflare.validate({ token: 'cf-token' }).catch((err: unknown) => err);
      expect(busy).toMatchObject({ message: `Cloudflare could not answer just now: it answered ${status}` });
      expect(failureOf(busy).kind).toBe('temporary');
      await expect(cloudflare.zone({ token: 'cf-token' }, 'koala.dev')).rejects.toMatchObject({ message: `Cloudflare could not answer just now: it answered ${status}` });

      const porkbun = porkbunProvider(answering(status, { status: 'ERROR', message: 'busy' }));
      const refused = await porkbun.validate(PORKBUN).catch((err: unknown) => err);
      expect(refused).toMatchObject({ message: `Porkbun could not answer just now: it answered ${status}` });
      expect(failureOf(refused).kind).toBe('temporary');
    }
  });

  it('still calls credentials the provider refuses wrong', async () => {
    expect(await cloudflareProvider(answering(403, { success: false, errors: [{ message: 'Invalid API Token' }] })).validate({ token: 'cf-token' })).toMatchObject({ valid: false, message: 'Cloudflare refused /zones: Invalid API Token.' });
    expect(await porkbunProvider(answering(400, { status: 'ERROR', message: 'Invalid API key. (002)' })).validate(PORKBUN)).toMatchObject({ valid: false, message: 'Porkbun refused /ping: Invalid API key. (002).' });
  });
});
