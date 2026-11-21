import { describe, expect, it } from 'vitest';
import { generateIdentityKey, identityKeysFrom } from './identity-token.js';
import {
  asIssuerRequest, BACKCHANNEL_PATH, CALLBACK_PATH, claimsFor, clientAt, claimsShaped, clientMetadata, instanceClient,
  logoutClaims, LOGOUT_EVENT, publicJwkOf, publicJwkShaped, safeNextPath, signInRefusal, signInWaitingFor,
} from './oidc.js';

const keys = identityKeysFrom(generateIdentityKey());
const jwk = publicJwkOf(keys);

describe('who root signs in where', () => {
  it('signs only its owner in to an instance', () => {
    expect(signInRefusal({ kind: 'instance', owner: 'u1' }, 'u1')).toBeUndefined();
    expect(signInRefusal({ kind: 'instance', owner: 'u1' }, 'u2')).toBe('this instance belongs to someone else');
  });

  it('issues an instance\'s owner the operator and owner claims there, and anyone else only a person\'s', () => {
    expect(claimsFor({ id: 'u1' }, { kind: 'instance', owner: 'u1' })).toEqual([{ role: 'person' }, { role: 'operator' }, { role: 'instance-owner' }]);
    expect(claimsFor({ id: 'u2', roles: ['operator'] }, { kind: 'instance', owner: 'u1' })).toEqual([{ role: 'person' }]);
  });

  it('reads back only claims it could have issued', () => {
    expect(claimsShaped([{ role: 'person' }, { role: 'shared', project: 'p1', as: 'client' }])).toBe(false);
    expect(claimsShaped([{ role: 'root' }])).toBe(false);
    expect(claimsShaped([{ role: 'person' }, { role: 'space-of', person: 'owner' }])).toBe(true);
    expect(claimsShaped([{ role: 'space-of' }])).toBe(false);
    expect(claimsShaped('person')).toBe(false);
  });
});

describe('an instance as root\'s client', () => {
  it('describes a client by the key it named, signing in back at its own address and hearing logouts there', () => {
    const metadata = clientMetadata({ clientId: 'inst-u1', kind: 'instance', url: 'https://u1.example.com/', key: jwk, owner: 'u1' });
    expect(metadata).toMatchObject({
      client_id: 'inst-u1',
      redirect_uris: [`https://u1.example.com${CALLBACK_PATH}`],
      backchannel_logout_uri: `https://u1.example.com${BACKCHANNEL_PATH}`,
      token_endpoint_auth_method: 'private_key_jwt',
      koala_kind: 'instance',
      koala_owner: 'u1',
    });
    expect((metadata.jwks as { keys: { kid: string }[] }).keys[0]!.kid).toBe(keys.kid);
  });

  it('knows an instance as a client only once it has named its key', () => {
    const record = { id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com' };
    expect(instanceClient(record)).toBeUndefined();
    expect(instanceClient({ ...record, signIn: { jwk, since: 'x' } })).toMatchObject({ clientId: 'inst-u1', owner: 'u1' });
  });

  it('says an instance has not registered at root until it has, and then that root waits to hear its address', () => {
    expect(signInWaitingFor({ url: '' })).toBe('your Koala has not registered at root yet; it does so as it starts, with the code root gave it when it was put on your machine');
    expect(signInWaitingFor({ url: '', signIn: { jwk, since: 'x' } })).toBe('your Koala has registered at root; root lets it in once your machine has told root the address Koala answers at, as putting Koala on it finishes');
    expect(signInWaitingFor({ url: 'https://u1.example.com', signIn: { jwk, since: 'x' } })).toBeUndefined();
  });

  it('holds a registered instance\'s token requests while its install has yet to tell root its address, and only then', () => {
    const record = { id: 'inst-u1', ownerId: 'u1', url: '', signIn: { jwk, since: 'x' } };
    const installing = { id: 'install-1', machineId: 'desk', at: 'x', state: 'installing' as const };
    expect(clientAt(undefined)).toBeUndefined();
    expect(clientAt({ ...record, signIn: undefined, install: installing })).toBeUndefined();
    expect(clientAt({ ...record, install: installing })).toEqual({ waiting: signInWaitingFor(record) });
    expect(clientAt({ ...record, install: { ...installing, state: 'asked' } })).toEqual({ waiting: signInWaitingFor(record) });
    expect(clientAt({ ...record, install: { ...installing, state: 'failed' } })).toBeUndefined();
    expect(clientAt(record)).toBeUndefined();
    expect(clientAt({ ...record, url: 'https://u1.example.com', install: installing })).toEqual({ client: instanceClient({ ...record, url: 'https://u1.example.com' }) });
  });

  it('takes a key only when its kid is its own thumbprint', () => {
    expect(publicJwkShaped(jwk)).toBe(true);
    expect(publicJwkShaped({ ...jwk, kid: 'chosen' })).toBe(false);
    expect(publicJwkShaped({ ...jwk, kty: 'RSA' })).toBe(false);
  });

  it('carries a revocation in a back-channel logout token for one client', () => {
    expect(logoutClaims('https://app.example.com/oidc', 'inst-u1', { subject: 'u1', at: '2026-10-29T00:00:00.000Z', why: 'signed-out-everywhere' }, 1_800_000_000)).toMatchObject({
      iss: 'https://app.example.com/oidc', aud: 'inst-u1', sub: 'u1', iat: 1_800_000_000, exp: 1_800_000_120, events: { [LOGOUT_EVENT]: {} },
      koala_revoked_at: '2026-10-29T00:00:00.000Z', koala_why: 'signed-out-everywhere',
    });
  });

  it('sends someone on only to a path of its own', () => {
    expect(safeNextPath('/projects/abc')).toBe('/projects/abc');
    expect(safeNextPath('//evil.example.com')).toBeUndefined();
    expect(safeNextPath('https://evil.example.com')).toBeUndefined();
    expect(safeNextPath('/a\nSet-Cookie: x')).toBeUndefined();
  });
});

describe('the provider answers as root\'s public address, whatever host a request named', () => {
  it('puts the issuer\'s own host and scheme on every request, over anything the client sent', () => {
    expect(asIssuerRequest('https://app.example.com/oidc', { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' }, true, '10.0.0.1'))
      .toEqual({ 'x-forwarded-host': 'app.example.com', 'x-forwarded-proto': 'https' });
    expect(asIssuerRequest('http://localhost:3231/oidc', {}, false, '127.0.0.1')).toEqual({ 'x-forwarded-host': 'localhost:3231', 'x-forwarded-proto': 'http', 'x-forwarded-for': '127.0.0.1' });
  });

  it('keeps the address the proxy in front reported, and trusts no client-sent one when nothing is in front', () => {
    expect(asIssuerRequest('https://app.example.com/oidc', { 'x-forwarded-for': '203.0.113.9' }, true, '127.0.0.1')['x-forwarded-for']).toBe('203.0.113.9');
    expect(asIssuerRequest('http://localhost:3231/oidc', { 'x-forwarded-for': '203.0.113.9' }, false, '10.0.2.15')['x-forwarded-for']).toBe('10.0.2.15');
  });
});
