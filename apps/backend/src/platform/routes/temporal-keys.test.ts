import { describe, expect, it } from 'vitest';
import { routesInProcess } from '../testing/routes.js';
import { temporalJwks } from '../lib/temporal-auth.js';
import { temporalKeysRouter } from './temporal-keys.js';

const PREFIX = '/.well-known/temporal-jwks.json';
const KEY = 'a-temporal-key-that-is-long-enough-to-derive-from';

describe('the public keys Temporal reads to check the tokens Koala signs', () => {
  it('serves the key set derived from the install\'s temporal key, never cached', async () => {
    const routes = await routesInProcess({ prefix: PREFIX, router: () => temporalKeysRouter({ temporalKey: KEY }), user: null, open: true });
    const answer = await routes.get(PREFIX);
    expect(answer.status).toBe(200);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.data).toEqual(JSON.parse(JSON.stringify(temporalJwks(KEY))));
  });

  it('answers nothing on any other path', async () => {
    const routes = await routesInProcess({ prefix: PREFIX, router: () => temporalKeysRouter({ temporalKey: KEY }), user: null, open: true });
    const answer = await routes.get(`${PREFIX}/other`);
    expect(answer.status).toBe(404);
  });
});
