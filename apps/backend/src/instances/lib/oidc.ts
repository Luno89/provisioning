import crypto from 'crypto';
import { decodeJwt } from 'jose';
import { ignore } from '@koala/engine-core/failures';
import { claimsOf, type ClaimedUser } from '../../platform/lib/permissions.js';
import type { Claim, RevokedBecause } from '../../platform/index.js';
import { kidOf, type IdentityKeyPair } from './identity-token.js';
import type { InstanceRecord } from './instances.js';
import { installUnfinished } from './koala-installs.js';
import { clientPrivateJwkOf, clientPublicJwkOf, machineRegistration, METRICS_SCOPE, metricsClientIdOf, OIDC_PATH, type ClientPublicJwk } from '@koala/engine-core/root-client';

export { OIDC_PATH };
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
export const LOGOUT_TOKEN_SECONDS = 120;
export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const OWNER_TOKEN_TYPE = 'urn:koala:params:oauth:token-type:owner';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const RUN_SCOPE = 'koala:run';
export const RUN_TOKEN_SECONDS = 5 * 60;
export const MACHINE_TOKEN_SECONDS = 5 * 60;
export const ACCESS_JWT_TYP = 'at+jwt';
export const REGISTRATION_POLICY = 'koala-instance';
export const runResourceOf = (clientId: string): string => `urn:koala:instance:${clientId}`;

export type ClientKind = 'instance' | 'machine' | 'machine-metrics' | 'root-web';

export interface RegisteringClient {
  kind: 'instance' | 'machine';
  id: string;
}

export const REGISTERING_FIELD = { instance: 'instanceId', machine: 'deviceId' } as const satisfies Record<RegisteringClient['kind'], string>;

export function registeringOf(bound: Record<string, unknown> | undefined): RegisteringClient | undefined {
  if (typeof bound?.instanceId === 'string') return { kind: 'instance', id: bound.instanceId };
  if (typeof bound?.deviceId === 'string') return { kind: 'machine', id: bound.deviceId };
  return undefined;
}

export const ROOT_WEB_CLIENT = 'root-web';

export const ROOT_WEB_ID_TOKEN_CLAIMS = JSON.stringify({ id_token: { sid: null } });

export type PublicJwk = ClientPublicJwk;

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

export const publicJwkOf = (keys: IdentityKeyPair): PublicJwk => clientPublicJwkOf(keys);

export const privateJwkOf = (keys: IdentityKeyPair): ReturnType<typeof clientPrivateJwkOf> => clientPrivateJwkOf(keys);

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
    grant_types: ['authorization_code', 'refresh_token', 'client_credentials', TOKEN_EXCHANGE],
    response_types: ['code'],
    scope: [...SIGN_IN_SCOPES, SERVICE_SCOPE, RUN_SCOPE].join(' '),
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: SIGNING_ALG,
    id_token_signed_response_alg: SIGNING_ALG,
    jwks: { keys: [{ ...client.key, alg: SIGNING_ALG, use: 'sig' }] },
    post_logout_redirect_uris: [`${base}/`],
    backchannel_logout_uri: `${base}${BACKCHANNEL_PATH}`,
    backchannel_logout_session_required: true,
    koala_kind: client.kind,
    ...(client.owner ? { koala_owner: client.owner } : {}),
  };
}

export const rootWebMetadata = (publicUrl: string, key: PublicJwk): Record<string, unknown> => {
  const base = origin(publicUrl);
  return {
    client_id: ROOT_WEB_CLIENT,
    redirect_uris: [`${base}${CALLBACK_PATH}`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: SIGN_IN_SCOPES.join(' '),
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: SIGNING_ALG,
    id_token_signed_response_alg: SIGNING_ALG,
    jwks: { keys: [{ ...key, alg: SIGNING_ALG, use: 'sig' }] },
    post_logout_redirect_uris: [`${base}/`],
    koala_kind: 'root-web',
  };
};

export interface KeptRootSession {
  session: string;
  grant: string;
  grantId: string;
}

export function keptRootSession(sessions: ReadonlyArray<{ id: string; payload: Record<string, unknown> | undefined }>, rootSid: string | undefined): KeptRootSession | undefined {
  if (!rootSid) return undefined;
  for (const { id, payload } of sessions) {
    const web = (payload?.authorizations as Record<string, { sid?: unknown; grantId?: unknown } | undefined> | undefined)?.[ROOT_WEB_CLIENT];
    if (web?.sid === rootSid && typeof web.grantId === 'string') return { session: id, grant: `Grant:${web.grantId}`, grantId: web.grantId };
  }
  return undefined;
}

export const instanceClient = (instance: Pick<InstanceRecord, 'id' | 'ownerId' | 'url' | 'signIn'>): ClientRegistration | undefined =>
  instance.signIn && instance.url ? { clientId: instance.id, kind: 'instance', url: instance.url, key: instance.signIn.jwk, owner: instance.ownerId } : undefined;

export const machineClientMetadata = (machine: { id: string; ownerId: string; key: PublicJwk; previous?: PublicJwk | undefined }): Record<string, unknown> => ({
  ...machineRegistration(machine.key),
  ...(machine.previous ? { jwks: { keys: [machine.key, machine.previous].map((key) => (machineRegistration(key).jwks as { keys: unknown[] }).keys[0]) } } : {}),
  client_id: machine.id,
  koala_kind: 'machine',
  koala_owner: machine.ownerId,
});

function basicPartOf(authorization: string | undefined, part: 'id' | 'secret'): string | undefined {
  const [scheme, encoded] = (authorization ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return undefined;
  const basic = Buffer.from(encoded, 'base64').toString('utf8');
  const colon = basic.indexOf(':');
  if (colon === -1) return undefined;
  try {
    return decodeURIComponent((part === 'id' ? basic.slice(0, colon) : basic.slice(colon + 1)).replace(/\+/g, '%20'));
  } catch {
    return undefined;
  }
}

export const basicSecretOf = (authorization: string | undefined): string | undefined => basicPartOf(authorization, 'secret');

export interface TokenRequestSeen {
  clientId?: string | undefined;
  params?: Record<string, unknown> | undefined;
  authorization?: string | undefined;
}

const assertedClientOf = (assertion: unknown): string | undefined => {
  if (typeof assertion !== 'string') return undefined;
  try {
    return decodeJwt(assertion).sub;
  } catch (err) {
    return ignore('an assertion root cannot read names no client, and the refusal is told without one')(err);
  }
};

export function refusedClientOf(seen: TokenRequestSeen): string | undefined {
  const named = seen.params?.client_id;
  return seen.clientId ?? (typeof named === 'string' && named ? named : undefined) ?? basicPartOf(seen.authorization, 'id') ?? assertedClientOf(seen.params?.client_assertion);
}

export interface TokenRefusal {
  error?: unknown;
  error_description?: unknown;
  error_detail?: unknown;
  message?: unknown;
}

const said = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function tokenRefusalLine(clientId: string | undefined, refusal: TokenRefusal): string {
  const error = said(refusal.error) ?? said(refusal.message) ?? 'an error it did not name';
  const description = said(refusal.error_description);
  const detail = said(refusal.error_detail);
  return `[sign-in] root refused ${clientId ?? 'a client that named no id'} at its token endpoint: ${error}${description ? ` (${description})` : ''}${detail ? `: ${detail}` : ''}`;
}

export const metricsClientMetadata = (machine: { id: string; ownerId: string; secret: string }): Record<string, unknown> => ({
  client_id: metricsClientIdOf(machine.id),
  client_secret: machine.secret,
  token_endpoint_auth_method: 'client_secret_basic',
  grant_types: ['client_credentials'],
  response_types: [],
  redirect_uris: [],
  scope: METRICS_SCOPE,
  koala_kind: 'machine-metrics',
  koala_owner: machine.ownerId,
});

export function signInRefusal(client: { kind: ClientKind; owner?: string | undefined }, accountId: string): string | undefined {
  if (client.kind === 'machine' || client.kind === 'machine-metrics') return 'a machine signs no one in';
  if (client.kind === 'instance' && client.owner !== accountId) return 'this instance belongs to someone else';
  return undefined;
}

export const SIGN_IN_KEY_NOT_NAMED = {
  instance: 'your Koala has not registered at root yet; it does so as it starts, with the code root gave it when it was put on your machine',
} as const;

export const ADDRESS_NOT_HEARD = {
  instance: 'your Koala has registered at root; root lets it in once your machine has told root the address Koala answers at, as putting Koala on it finishes',
} as const;

export const REGISTRATION_REFUSED = 'root refused this instance\'s registration code (it was used, or a newer one replaced it), and does not know its key: put Koala on your machine again';

export const registeredKeyOf = (metadata: Record<string, unknown>): PublicJwk | undefined => {
  const keys = (metadata.jwks as { keys?: unknown } | undefined)?.keys;
  if (!Array.isArray(keys) || keys.length !== 1) return undefined;
  const { kty, crv, x, kid } = (keys[0] ?? {}) as Partial<PublicJwk>;
  const key = { kty, crv, x, kid };
  return publicJwkShaped(key) ? key : undefined;
};

export const registrationMetadata = (client: Omit<ClientRegistration, 'clientId'>): Record<string, unknown> => {
  const { client_id: _id, ...metadata } = clientMetadata({ ...client, clientId: '' });
  return metadata;
};

export const signInWaitingFor = (instance: Pick<InstanceRecord, 'signIn' | 'url'>): string | undefined => {
  if (!instance.signIn) return SIGN_IN_KEY_NOT_NAMED.instance;
  return instance.url ? undefined : ADDRESS_NOT_HEARD.instance;
};

export type ClientAt = { client: ClientRegistration } | { waiting: string } | undefined;

export function clientAt(instance: Pick<InstanceRecord, 'id' | 'ownerId' | 'url' | 'signIn' | 'install'> | undefined): ClientAt {
  if (!instance) return undefined;
  const client = instanceClient(instance);
  if (client) return { client };
  const waiting = signInWaitingFor(instance);
  return instance.signIn && waiting && installUnfinished(instance.install) ? { waiting } : undefined;
}

export const claimsFor = (user: ClaimedUser, client: { kind: ClientKind; owner?: string | undefined }): Claim[] =>
  client.kind === 'root-web' ? claimsOf(user, { role: 'root' }) : claimsOf(user, { role: 'instance', instanceOwnerId: client.owner });

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
  exp: number;
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
  exp: now + LOGOUT_TOKEN_SECONDS,
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

export const logoutPage = (form: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Signing out of Koala</title><body onload="document.forms['op.logoutForm'].submit()" style="font-family:system-ui;padding:2rem">${form.replace('</form>', '<input type="hidden" name="logout" value="yes"/></form>')}<p>Signing this browser out of Koala…</p></body>`;
