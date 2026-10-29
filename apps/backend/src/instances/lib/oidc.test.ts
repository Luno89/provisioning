import { describe, expect, it } from 'vitest';
import { generateIdentityKey, identityKeysFrom } from './identity-token.js';
import {
  BACKCHANNEL_PATH, CALLBACK_PATH, claimsFor, claimsShaped, clientKeysFrom, clientMetadata, handoffServedFor, hubClient, instanceClient,
  logoutClaims, LOGOUT_EVENT, publicJwkOf, publicJwkShaped, safeNextPath, signInRefusal, startsSignInItself,
} from './oidc.js';

const keys = identityKeysFrom(generateIdentityKey());
const jwk = publicJwkOf(keys);

describe('who root signs in where', () => {
  it('signs only its owner in to an instance, and anyone in to the hub', () => {
    expect(signInRefusal({ kind: 'instance', owner: 'u1' }, 'u1')).toBeUndefined();
    expect(signInRefusal({ kind: 'instance', owner: 'u1' }, 'u2')).toBe('this instance belongs to someone else');
    expect(signInRefusal({ kind: 'hub' }, 'u2')).toBeUndefined();
  });

  it('issues an instance\'s owner the operator and owner claims there, anyone else only a person\'s, and nobody an operator\'s on the hub', () => {
    expect(claimsFor({ id: 'u1' }, { kind: 'instance', owner: 'u1' })).toEqual([{ role: 'person' }, { role: 'operator' }, { role: 'instance-owner' }]);
    expect(claimsFor({ id: 'u2', roles: ['operator'] }, { kind: 'instance', owner: 'u1' })).toEqual([{ role: 'person' }]);
    expect(claimsFor({ id: 'u1', roles: ['operator'] }, { kind: 'hub' })).toEqual([{ role: 'person' }]);
  });

  it('reads back only claims it could have issued', () => {
    expect(claimsShaped([{ role: 'person' }, { role: 'shared', project: 'p1', as: 'client' }])).toBe(true);
    expect(claimsShaped([{ role: 'root' }])).toBe(false);
    expect(claimsShaped([{ role: 'shared', project: 'p1', as: 'admin' }])).toBe(false);
    expect(claimsShaped('person')).toBe(false);
  });
});

describe('an instance or the hub as root\'s client', () => {
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

  it('knows an instance or the hub as a client only once it has named its key', () => {
    const record = { id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com' };
    expect(instanceClient(record)).toBeUndefined();
    expect(instanceClient({ ...record, signIn: { jwk, since: 'x' } })).toMatchObject({ clientId: 'inst-u1', owner: 'u1' });
    expect(hubClient('https://hub.example.com', undefined)).toBeUndefined();
    expect(hubClient('https://hub.example.com', { jwk, since: 'x' })).toMatchObject({ clientId: 'hub', kind: 'hub' });
  });

  it('keeps root\'s old handoff for an instance until it names its sign-in key, and again once it has gone back to a release that cannot start one', () => {
    expect(handoffServedFor({}, undefined)).toBe(true);
    expect(handoffServedFor({ signIn: { jwk, since: 'x' } }, true)).toBe(false);
    expect(handoffServedFor({ signIn: { jwk, since: 'x' } }, undefined)).toBe(false);
    expect(handoffServedFor({ signIn: { jwk, since: 'x' } }, false)).toBe(true);
    expect(startsSignInItself({ url: '/api/auth/oidc/start' })).toBe(true);
    expect(startsSignInItself({ url: 'https://app.example.com/api/identity/go' })).toBe(false);
  });

  it('takes a named key only when its kid is its own thumbprint, and derives the same key from the same session key', () => {
    expect(publicJwkShaped(jwk)).toBe(true);
    expect(publicJwkShaped({ ...jwk, kid: 'chosen' })).toBe(false);
    expect(publicJwkShaped({ ...jwk, kty: 'RSA' })).toBe(false);
    expect(clientKeysFrom('a-session-key').kid).toBe(clientKeysFrom('a-session-key').kid);
    expect(clientKeysFrom('a-session-key').kid).not.toBe(clientKeysFrom('another-session-key').kid);
  });

  it('carries a revocation in a back-channel logout token for one client', () => {
    expect(logoutClaims('https://app.example.com/oidc', 'inst-u1', { subject: 'u1', at: '2026-10-29T00:00:00.000Z', why: 'signed-out-everywhere' }, 1_800_000_000)).toMatchObject({
      iss: 'https://app.example.com/oidc', aud: 'inst-u1', sub: 'u1', iat: 1_800_000_000, events: { [LOGOUT_EVENT]: {} },
      koala_revoked_at: '2026-10-29T00:00:00.000Z', koala_why: 'signed-out-everywhere',
    });
  });

  it('sends someone on only to a path of its own', () => {
    expect(safeNextPath('/hub/join/abc')).toBe('/hub/join/abc');
    expect(safeNextPath('//evil.example.com')).toBeUndefined();
    expect(safeNextPath('https://evil.example.com')).toBeUndefined();
    expect(safeNextPath('/a\nSet-Cookie: x')).toBeUndefined();
  });
});
