import * as client from 'openid-client';
import { importJWK } from 'jose';
import { keepTrying, refusedByServer, reopening, withAnswerUnlimited, type Reopening } from '../../platform/index.js';
import type { IdentityKeyPair } from '../lib/identity-token.js';
import { privateJwkOf, publicJwkOf, REGISTRATION_REFUSED, registrationMetadata, SERVICE_SCOPE, SIGNING_ALG, type ClientKind } from '../lib/oidc.js';

export interface RootClientSettings {
  kind: ClientKind;
  clientId: string;
  rootUrl: string;
  publicUrl: string;
  owner?: string | undefined;
  keys: IdentityKeyPair;
  registrationCode: string;
}

const errorOf = (err: unknown): string | undefined => {
  const known = err as { name?: unknown; error?: unknown; cause?: unknown };
  if (refusedByServer(err) && typeof known.error === 'string') return known.error;
  const challenge = known.name === 'WWWAuthenticateChallengeError' && Array.isArray(known.cause) ? (known.cause[0] as { parameters?: { error?: unknown } } | undefined) : undefined;
  return typeof challenge?.parameters?.error === 'string' ? challenge.parameters.error : undefined;
};

export class RootClient {
  private configured: Promise<client.Configuration> | undefined;
  private held: { value: string; until: number } | undefined;
  private markRegistered: () => void = () => undefined;
  readonly registered: Promise<void> = new Promise((resolve) => { this.markRegistered = resolve; });

  constructor(
    private readonly settings: RootClientSettings,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get issuer(): string {
    return `${this.settings.rootUrl}/oidc`;
  }

  get clientId(): string {
    return this.settings.clientId;
  }

  private options(): client.DiscoveryRequestOptions {
    return { ...withAnswerUnlimited(), ...(this.issuer.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : {}) };
  }

  private async authentication(): Promise<client.ClientAuth> {
    const key = await importJWK(privateJwkOf(this.settings.keys), SIGNING_ALG) as Extract<Parameters<typeof client.PrivateKeyJwt>[0], { type: string }>;
    return client.PrivateKeyJwt({ key, kid: this.settings.keys.kid });
  }

  config(): Promise<client.Configuration> {
    this.configured ??= (async () => client.discovery(
      new URL(this.issuer),
      this.settings.clientId,
      { id_token_signed_response_alg: SIGNING_ALG, token_endpoint_auth_signing_alg: SIGNING_ALG },
      await this.authentication(),
      this.options(),
    ))();
    this.configured.catch(() => { this.configured = undefined; });
    return this.configured;
  }

  private async freshServiceToken(): Promise<string> {
    const now = this.now();
    const granted = await client.clientCredentialsGrant(await this.config(), { scope: SERVICE_SCOPE });
    this.held = { value: granted.access_token, until: now + Math.max(30, (granted.expires_in ?? 60) - 30) * 1000 };
    return granted.access_token;
  }

  async register(): Promise<void> {
    try {
      await this.freshServiceToken();
      this.markRegistered();
      return;
    } catch (err) {
      if (errorOf(err) !== 'invalid_client') throw err;
    }
    const { kind, publicUrl, owner, keys, registrationCode } = this.settings;
    try {
      await client.dynamicClientRegistration(new URL(this.issuer), registrationMetadata({ kind, url: publicUrl, key: publicJwkOf(keys), owner }) as Partial<client.ClientMetadata>, await this.authentication(), { ...this.options(), initialAccessToken: registrationCode });
    } catch (err) {
      if (errorOf(err) === 'invalid_token') throw new Error(REGISTRATION_REFUSED);
      throw err;
    }
    this.markRegistered();
  }

  keepRegistering(log: (message: string) => void, again: Reopening = reopening()): void {
    void keepTrying(`root has not registered this ${this.settings.kind} yet`, () => this.register(), log, again);
  }

  async serviceToken(): Promise<string> {
    await this.registered;
    if (this.held && this.held.until > this.now()) return this.held.value;
    return this.freshServiceToken();
  }
}
