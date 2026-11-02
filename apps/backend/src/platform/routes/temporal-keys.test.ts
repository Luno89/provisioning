import { describe, expect, it } from 'vitest';
import { callRouter } from '../../accounts/testing/call-router.js';
import { temporalJwks } from '../lib/temporal-auth.js';
import { temporalKeysRouter } from './temporal-keys.js';

const KEY = 'a-temporal-key-that-is-long-enough-to-derive-from';

describe('the public keys Temporal reads to check the tokens Koala signs', () => {
  it('serves the key set derived from the install\'s temporal key, never cached', async () => {
    const answer = await callRouter(temporalKeysRouter({ temporalKey: KEY }), '/.well-known/temporal-jwks.json', { user: null });
    expect(answer.status).toBe(200);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.body).toEqual(JSON.parse(JSON.stringify(temporalJwks(KEY))));
  });

  it('answers nothing on any other path', async () => {
    const answer = await callRouter(temporalKeysRouter({ temporalKey: KEY }), '/.well-known/temporal-jwks.json', { path: '/other', user: null });
    expect(answer.status).toBe(404);
  });
});
