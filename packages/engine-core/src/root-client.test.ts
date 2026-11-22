import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clientKeysFrom, clientPublicJwkOf, machineRegistration, MACHINE_SCOPE, newClientKey } from './root-client.js';

describe('a client of root', () => {
  it('names its key by the hash of its public half, the same for the same key and different for another', () => {
    const pem = newClientKey();
    const keys = clientKeysFrom(pem);
    expect(keys.kid).toBe(crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16));
    expect(clientKeysFrom(pem).kid).toBe(keys.kid);
    expect(clientKeysFrom(newClientKey()).kid).not.toBe(keys.kid);
  });

  it('registers a machine with only the public half of its key, asking for nothing but its own tokens', () => {
    const keys = clientKeysFrom(newClientKey());
    const asked = machineRegistration(clientPublicJwkOf(keys));
    expect(asked).toMatchObject({ grant_types: ['client_credentials'], response_types: [], redirect_uris: [], scope: MACHINE_SCOPE, token_endpoint_auth_method: 'private_key_jwt' });
    expect(asked.jwks).toEqual({ keys: [{ ...clientPublicJwkOf(keys), alg: 'Ed25519', use: 'sig' }] });
    expect(JSON.stringify(asked)).not.toContain(String((keys.privateKey.export({ format: 'jwk' }) as { d?: string }).d));
  });
});
