import crypto from 'crypto';
import { claimsOf, type ClaimedUser } from '../../platform/lib/permissions.js';
import type { Claim, RevokedBecause } from '../../platform/index.js';
import { identityKeysFromSeed, kidOf, type IdentityKeyPair } from './identity-token.js';
import type { InstanceRecord } from './instances.js';

export const OIDC_PATH = '/oidc';
export const INTERACTION_PATH = `${OIDC_PATH}/interaction`;
export const START_PATH = '/api/auth/oidc/start';
export const CALLBACK_PATH = '/api/auth/oidc/callback';
export const BACKCHANNEL_PATH = '/api/auth/oidc/backchannel-logout';
export const KOALA_SCOPE = 'koala';
export const SERVICE_SCOPE = 'koala:service';
export const SIGN_IN_SCOPES = ['openid', 'email', 'offline_access', KOALA_SCOPE] as const;
export const KOALA_CLAIMS = 'koala_claims';
export const CLAIMS_SECONDS = 20 * 60;
export const SESSION_SECONDS = 14 * 24 * 60 * 60;
export const SERVICE_TOKEN_SECONDS = 5 * 60;
export const SIGNING_ALG = 'Ed25519';
export const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
export const LOGOUT_TYP = 'logout+jwt';

export type ClientKind = 'instance';

export interface PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
}

export interface SignInKey {
  jwk: PublicJwk;
  since: string;
}

export interface ClientRegistration {
  clientId: string;
  kind: ClientKind;
  url: string;
  key: PublicJwk;
  owner?: string | undefined;
}

export const publicJwkOf = (keys: IdentityKeyPair): PublicJwk => {
  const exported = keys.publicKey.export({ format: 'jwk' }) as { x?: string };
  return { kty: 'OKP', crv: 'Ed25519', x: exported.x ?? '', kid: keys.kid };
};

export const privateJwkOf = (keys: IdentityKeyPair): crypto.JsonWebKey & { kid: string } =>
  ({ ...(keys.privateKey.export({ format: 'jwk' }) as crypto.JsonWebKey), kid: keys.kid });

export const clientKeysFrom = (sessionKey: string): IdentityKeyPair =>
  identityKeysFromSeed(Buffer.from(crypto.hkdfSync('sha256', sessionKey, 'koala-sign-in-client', 'ed25519', 32)));

export const publicJwkShaped = (value: unknown): value is PublicJwk => {
  const jwk = value as Partial<PublicJwk> | undefined;
  if (jwk?.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || typeof jwk.kid !== 'string') return false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
    return kidOf(key) === jwk.kid;
  } catch {
    return false;
  }
};

const origin = (url: string): string => url.replace(/\/+$/, '');

export function clientMetadata(client: ClientRegistration): Record<string, unknown> {
  const base = origin(client.url);
  return {
    client_id: client.clientId,
    redirect_uris: [`${base}${CALLBACK_PATH}`],
    grant_types: ['authorization_code', 'refresh_token', 'client_credentials'],
    response_types: ['code'],
    scope: [...SIGN_IN_SCOPES, SERVICE_SCOPE].join(' '),
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: SIGNING_ALG,
    id_token_signed_response_alg: SIGNING_ALG,
    jwks: { keys: [{ ...client.key, alg: SIGNING_ALG, use: 'sig' }] },
    backchannel_logout_uri: `${base}${BACKCHANNEL_PATH}`,
    backchannel_logout_session_required: false,
    koala_kind: client.kind,
    ...(client.owner ? { koala_owner: client.owner } : {}),
  };
}

export const instanceClient = (instance: Pick<InstanceRecord, 'id' | 'ownerId' | 'url' | 'signIn'>): ClientRegistration | undefined =>
  instance.signIn && instance.url ? { clientId: instance.id, kind: 'instance', url: instance.url, key: instance.signIn.jwk, owner: instance.ownerId } : undefined;

export function signInRefusal(client: { kind: ClientKind; owner?: string | undefined }, accountId: string): string | undefined {
  if (client.kind === 'instance' && client.owner !== accountId) return 'this instance belongs to someone else';
  return undefined;
}

export const SIGN_IN_KEY_NOT_NAMED = {
  instance: 'your Koala has not named its sign-in key to root yet; it does so as it starts',
} as const;

export const signInWaitingFor = (instance: Pick<InstanceRecord, 'signIn'>): string | undefined =>
  instance.signIn ? undefined : SIGN_IN_KEY_NOT_NAMED.instance;

export const claimsFor = (user: ClaimedUser, client: { kind: ClientKind; owner?: string | undefined }): Claim[] =>
  claimsOf(user, { role: 'instance', instanceOwnerId: client.owner });

export const CLAIM_ROLES: readonly Claim['role'][] = ['person', 'operator', 'instance-owner', 'space-of'];

export const claimsShaped = (value: unknown): value is Claim[] =>
  Array.isArray(value) && value.every((claim) => {
    const role = (claim as { role?: unknown } | undefined)?.role;
    if (role === 'space-of') return typeof (claim as { person?: unknown }).person === 'string';
    return role === 'person' || role === 'operator' || role === 'instance-owner';
  });

export interface LogoutClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  jti: string;
  events: Record<string, Record<string, never>>;
  koala_revoked_at: string;
  koala_why: RevokedBecause;
}

export const logoutClaims = (issuer: string, clientId: string, revoked: { subject: string; at: string; why: RevokedBecause }, now: number): LogoutClaims => ({
  iss: issuer,
  aud: clientId,
  sub: revoked.subject,
  iat: now,
  jti: crypto.randomUUID(),
  events: { [LOGOUT_EVENT]: {} },
  koala_revoked_at: revoked.at,
  koala_why: revoked.why,
});

export const safeNextPath = (next: unknown): string | undefined =>
  typeof next === 'string' && /^\/[^/\\]/.test(next) && !/[\r\n]/.test(next) ? next : undefined;

type RequestHeaders = Readonly<Record<string, string | string[] | undefined>>;

export function asIssuerRequest(issuer: string, headers: RequestHeaders, proxied: boolean, remoteAddress: string | undefined): Record<string, string | string[]> {
  const origin = new URL(issuer);
  const forwardedFor = proxied ? headers['x-forwarded-for'] : remoteAddress;
  return {
    'x-forwarded-host': origin.host,
    'x-forwarded-proto': origin.protocol.replace(/:$/, ''),
    ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
  };
}
