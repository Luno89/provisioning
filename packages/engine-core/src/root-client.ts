import crypto from 'node:crypto';
import * as client from 'openid-client';
import { importJWK, type JWK } from 'jose';
import { refusedByServer } from './failures.js';

export const CLIENT_SIGNING_ALG = 'Ed25519';
export const MACHINE_SCOPE = 'koala:machine';
export const MACHINE_REGISTRATION_REFUSED = 'root refused this machine\'s registration code (it was used, or a newer join replaced it): run the command from My Machines again';

export interface ClientKeys {
  kid: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
}

export interface ClientPublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
}

export const kidOf = (publicKey: crypto.KeyObject): string =>
  crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

export function clientKeysFrom(privateKeyPem: string): ClientKeys {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKey = crypto.createPublicKey(privateKeyPem);
  return { kid: kidOf(publicKey), privateKey, publicKey };
}

export const newClientKey = (): string =>
  crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

export const clientPublicJwkOf = (keys: ClientKeys): ClientPublicJwk => {
  const exported = keys.publicKey.export({ format: 'jwk' }) as { x?: string };
  return { kty: 'OKP', crv: 'Ed25519', x: exported.x ?? '', kid: keys.kid };
};

export const clientPrivateJwkOf = (keys: ClientKeys): JWK & { kid: string } =>
  ({ ...(keys.privateKey.export({ format: 'jwk' }) as JWK), kid: keys.kid });

export const machineRegistration = (key: ClientPublicJwk): Record<string, unknown> => ({
  grant_types: ['client_credentials'],
  response_types: [],
  redirect_uris: [],
  scope: MACHINE_SCOPE,
  token_endpoint_auth_method: 'private_key_jwt',
  token_endpoint_auth_signing_alg: CLIENT_SIGNING_ALG,
  jwks: { keys: [{ ...key, alg: CLIENT_SIGNING_ALG, use: 'sig' }] },
});

const fetchNow: typeof fetch = (input, init) => globalThis.fetch(input, init);

export const answerUnlimited = (doFetch: typeof fetch = fetchNow): client.CustomFetch =>
  (url, options) => {
    const { signal: _theirLimit, ...rest } = options;
    return doFetch(url, rest as RequestInit);
  };

export const withAnswerUnlimited = (doFetch: typeof fetch = fetchNow) => ({ [client.customFetch]: answerUnlimited(doFetch) });

export interface OidcClientSettings {
  clientId: string;
  issuer: string;
  keys: ClientKeys;
  registrationCode: string;
  registration: Record<string, unknown>;
  refused: string;
  scope: string;
  reach?: typeof fetch | undefined;
}

const errorOf = (err: unknown): string | undefined => {
  const known = err as { name?: unknown; error?: unknown; cause?: unknown };
  if (refusedByServer(err) && typeof known.error === 'string') return known.error;
  const challenge = known.name === 'WWWAuthenticateChallengeError' && Array.isArray(known.cause) ? (known.cause[0] as { parameters?: { error?: unknown } } | undefined) : undefined;
  return typeof challenge?.parameters?.error === 'string' ? challenge.parameters.error : undefined;
};

export class OidcClient {
  private configured: Promise<client.Configuration> | undefined;
  private held: { value: string; until: number } | undefined;
  private markRegistered: () => void = () => undefined;
  readonly registered: Promise<void> = new Promise((resolve) => { this.markRegistered = resolve; });

  constructor(
    private readonly parts: OidcClientSettings,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get issuer(): string {
    return this.parts.issuer;
  }

  get clientId(): string {
    return this.parts.clientId;
  }

  private options(): client.DiscoveryRequestOptions {
    return { ...withAnswerUnlimited(this.parts.reach), ...(this.issuer.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : {}) };
  }

  private async authentication(): Promise<client.ClientAuth> {
    const key = await importJWK(clientPrivateJwkOf(this.parts.keys), CLIENT_SIGNING_ALG) as Extract<Parameters<typeof client.PrivateKeyJwt>[0], { type: string }>;
    return client.PrivateKeyJwt({ key, kid: this.parts.keys.kid });
  }

  config(): Promise<client.Configuration> {
    this.configured ??= (async () => client.discovery(
      new URL(this.issuer),
      this.parts.clientId,
      { id_token_signed_response_alg: CLIENT_SIGNING_ALG, token_endpoint_auth_signing_alg: CLIENT_SIGNING_ALG },
      await this.authentication(),
      this.options(),
    ))();
    this.configured.catch(() => { this.configured = undefined; });
    return this.configured;
  }

  private async freshToken(): Promise<string> {
    const now = this.now();
    const granted = await client.clientCredentialsGrant(await this.config(), { scope: this.parts.scope });
    this.held = { value: granted.access_token, until: now + Math.max(30, (granted.expires_in ?? 60) - 30) * 1000 };
    return granted.access_token;
  }

  async register(): Promise<void> {
    try {
      await this.freshToken();
      this.markRegistered();
      return;
    } catch (err) {
      if (errorOf(err) !== 'invalid_client') throw err;
    }
    try {
      await client.dynamicClientRegistration(new URL(this.issuer), this.parts.registration as Partial<client.ClientMetadata>, await this.authentication(), { ...this.options(), initialAccessToken: this.parts.registrationCode });
    } catch (err) {
      if (errorOf(err) === 'invalid_token') throw new Error(this.parts.refused);
      throw err;
    }
    this.markRegistered();
  }

  async token(): Promise<string> {
    if (this.held && this.held.until > this.now()) return this.held.value;
    return this.freshToken();
  }
}
