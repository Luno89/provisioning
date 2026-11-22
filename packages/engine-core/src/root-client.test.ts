import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clientKeysFrom, clientPublicJwkOf, KEY_REPLACEMENT_REFUSED, keyReplacementFrom, machineClientOf, machineKeyDue, machineKeyEnds, machineRegistration, MachineClient, MACHINE_SCOPE, newClientKey, rootIssuerOf } from './root-client.js';

describe('a client of root', () => {
  it('names its key by the hash of its public half, the same for the same key and different for another', () => {
    const pem = newClientKey();
    const keys = clientKeysFrom(pem);
    expect(keys.kid).toBe(crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16));
    expect(clientKeysFrom(pem).kid).toBe(keys.kid);
    expect(clientKeysFrom(newClientKey()).kid).not.toBe(keys.kid);
  });

  it('finds root\'s provider under root\'s own address, however the address was written', () => {
    expect(rootIssuerOf('https://koala.example')).toBe('https://koala.example/oidc');
    expect(rootIssuerOf('https://koala.example//')).toBe('https://koala.example/oidc');
    const machine = machineClientOf({ rootUrl: 'https://koala.example/', deviceId: 'desk-1', key: newClientKey() });
    expect([machine.issuer, machine.clientId]).toEqual(['https://koala.example/oidc', 'desk-1']);
  });

  it('registers a machine with only the public half of its key, asking for nothing but its own tokens', () => {
    const keys = clientKeysFrom(newClientKey());
    const asked = machineRegistration(clientPublicJwkOf(keys));
    expect(asked).toMatchObject({ grant_types: ['client_credentials'], response_types: [], redirect_uris: [], scope: MACHINE_SCOPE, token_endpoint_auth_method: 'private_key_jwt' });
    expect(asked.jwks).toEqual({ keys: [{ ...clientPublicJwkOf(keys), alg: 'Ed25519', use: 'sig' }] });
    expect(JSON.stringify(asked)).not.toContain(String((keys.privateKey.export({ format: 'jwk' }) as { d?: string }).d));
  });

  it('takes a key replacement root offers only when it names its one-use token and where the machine\'s registration is', () => {
    expect(keyReplacementFrom({ registrationAccessToken: 'rat', registrationClientUri: 'https://koala.example/oidc/reg/desk-1' })).toEqual({ registrationAccessToken: 'rat', registrationClientUri: 'https://koala.example/oidc/reg/desk-1' });
    expect(keyReplacementFrom({ registrationAccessToken: '', registrationClientUri: 'https://koala.example/oidc/reg/desk-1' })).toBeUndefined();
    expect(keyReplacementFrom({ registrationAccessToken: 'rat', registrationClientUri: 'not an address' })).toBeUndefined();
    expect(keyReplacementFrom(undefined)).toBeUndefined();
  });

  it('replaces its key by sending only the new public half with the one-use token, and says root refused when the token was not taken', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const reach = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(status === 200 ? '{}' : 'no', { status });
    }) as unknown as typeof fetch;
    const machine = machineClientOf({ rootUrl: 'https://koala.example', deviceId: 'desk-1', key: newClientKey(), reach });
    const next = newClientKey();
    await machine.replaceKey({ registrationAccessToken: 'rat', registrationClientUri: 'https://koala.example/oidc/reg/desk-1' }, next);
    expect(sent[0]?.url).toBe('https://koala.example/oidc/reg/desk-1');
    expect(sent[0]?.init).toMatchObject({ method: 'PUT', headers: { authorization: 'Bearer rat' } });
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ client_id: 'desk-1', ...machineRegistration(clientPublicJwkOf(clientKeysFrom(next))) });
    status = 401;
    await expect(machine.replaceKey({ registrationAccessToken: 'rat', registrationClientUri: 'https://koala.example/oidc/reg/desk-1' }, newClientKey())).rejects.toMatchObject({ message: KEY_REPLACEMENT_REFUSED, answered: true });
    status = 500;
    await expect(machine.replaceKey({ registrationAccessToken: 'rat', registrationClientUri: 'https://koala.example/oidc/reg/desk-1' }, newClientKey())).rejects.toMatchObject({ message: 'root did not take this machine\'s new key (500): no', answered: true });
  });

  it('asks root for a token for a resource it names, holds it apart from its own token, and asks again once it nears its end', async () => {
    const asked: Array<string | null> = [];
    let now = 0;
    const reach = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/.well-known/openid-configuration')) {
        return Response.json({ issuer: 'https://koala.example/oidc', token_endpoint: 'https://koala.example/oidc/token', token_endpoint_auth_methods_supported: ['private_key_jwt'] });
      }
      const resource = new URLSearchParams(String(init?.body)).get('resource');
      asked.push(resource);
      return Response.json({ access_token: `token-${asked.length}-for-${resource ?? 'root'}`, token_type: 'Bearer', expires_in: 300 });
    }) as unknown as typeof fetch;
    const machine = new MachineClient(
      { clientId: 'desk-1', issuer: 'https://koala.example/oidc', keys: clientKeysFrom(newClientKey()), registrationCode: '', registration: {}, refused: '', scope: MACHINE_SCOPE, reach },
      () => now,
    );
    expect(await machine.token('urn:koala:instance:inst-1')).toBe('token-1-for-urn:koala:instance:inst-1');
    expect(await machine.token()).toBe('token-2-for-root');
    expect(await machine.token('urn:koala:instance:inst-1')).toBe('token-1-for-urn:koala:instance:inst-1');
    now = 271_000;
    expect(await machine.token('urn:koala:instance:inst-1')).toBe('token-3-for-urn:koala:instance:inst-1');
    expect(await machine.freshToken('urn:koala:instance:inst-1')).toBe('token-4-for-urn:koala:instance:inst-1');
    expect(asked).toEqual(['urn:koala:instance:inst-1', null, 'urn:koala:instance:inst-1', 'urn:koala:instance:inst-1']);
  });

  it('says a key is due to be replaced in the last 30 of its 90 days', () => {
    const since = '2026-01-01T00:00:00.000Z';
    const ends = machineKeyEnds(since);
    expect(ends).toBe(Date.parse(since) + 90 * 24 * 3600 * 1000);
    expect(machineKeyDue(ends, ends - 31 * 24 * 3600 * 1000)).toBe(false);
    expect(machineKeyDue(ends, ends - 30 * 24 * 3600 * 1000)).toBe(true);
  });
});
