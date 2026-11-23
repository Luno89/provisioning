import crypto from 'node:crypto';
import * as client from 'openid-client';
import { importJWK, type JWK } from 'jose';
import { ignore, refusedByServer } from './failures.js';

export const OIDC_PATH = '/oidc';
export const rootIssuerOf = (rootUrl: string): string => `${rootUrl.replace(/\/+$/, '')}${OIDC_PATH}`;
export const CLIENT_SIGNING_ALG = 'Ed25519';
export const MACHINE_SCOPE = 'koala:machine';
export const METRICS_SCOPE = 'koala:metrics';
export const rootTokenUrlOf = (rootUrl: string): string => `${rootIssuerOf(rootUrl)}/token`;

const METRICS_CLIENT_PREFIX = 'metrics.';
export const metricsClientIdOf = (deviceId: string): string => `${METRICS_CLIENT_PREFIX}${deviceId}`;
export const machineOfMetricsClient = (clientId: string): string | undefined =>
  (clientId.startsWith(METRICS_CLIENT_PREFIX) && clientId.length > METRICS_CLIENT_PREFIX.length ? clientId.slice(METRICS_CLIENT_PREFIX.length) : undefined);
export const METRICS_CLIENT_SECRET = { namespace: 'monitoring', name: 'koala-metrics', idKey: 'client_id', secretKey: 'client_secret' } as const;
export const METRICS_CLIENT_FIELDS = { id: 'koala_metrics_client_id', secret: 'koala_metrics_client_secret' } as const;

export interface MetricsClient {
  clientId: string;
  clientSecret: string;
}

export const metricsClientManifest = (client: MetricsClient): string => `${JSON.stringify({
  apiVersion: 'v1',
  kind: 'List',
  items: [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: METRICS_CLIENT_SECRET.namespace } },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: METRICS_CLIENT_SECRET.name, namespace: METRICS_CLIENT_SECRET.namespace },
      type: 'Opaque',
      stringData: { [METRICS_CLIENT_SECRET.idKey]: client.clientId, [METRICS_CLIENT_SECRET.secretKey]: client.clientSecret },
    },
  ],
}, null, 2)}\n`;

export const METRICS_CLIENT_NOT_GIVEN = 'root registered this machine but named no client for its Prometheus, so the machine could not send its metrics: run the command from My Machines again';

export function metricsClientFrom(reply: Record<string, unknown> | undefined): MetricsClient {
  const clientId = reply?.[METRICS_CLIENT_FIELDS.id];
  const clientSecret = reply?.[METRICS_CLIENT_FIELDS.secret];
  if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) throw new Error(METRICS_CLIENT_NOT_GIVEN);
  return { clientId, clientSecret };
}

export const MACHINE_REGISTRATION_REFUSED = 'root refused this machine\'s registration code (it was used, or a newer join replaced it): run the command from My Machines again';
export const MACHINE_KEY_DAYS = 90;
export const REPLACE_KEY_WITHIN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const machineKeyEnds = (since: string): number => Date.parse(since) + MACHINE_KEY_DAYS * DAY_MS;
export const machineKeyDue = (keyEnds: number, now: number): boolean => keyEnds - now <= REPLACE_KEY_WITHIN_DAYS * DAY_MS;
export const KEY_REPLACEMENT_REFUSED = 'root refused to replace this machine\'s key with the offer it gave (the offer was used or ran out); root offers again as the machine connects';

export interface KeyReplacement {
  registrationAccessToken: string;
  registrationClientUri: string;
}

export const keyReplacementFrom = (raw: unknown): KeyReplacement | undefined => {
  const { registrationAccessToken, registrationClientUri } = (raw ?? {}) as Partial<Record<keyof KeyReplacement, unknown>>;
  return typeof registrationAccessToken === 'string' && registrationAccessToken && typeof registrationClientUri === 'string' && URL.canParse(registrationClientUri)
    ? { registrationAccessToken, registrationClientUri }
    : undefined;
};

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

export const clientRefused = (err: unknown): boolean => errorOf(err) === 'invalid_client';

export class OidcClient {
  private configured: Promise<client.Configuration> | undefined;
  private readonly held = new Map<string, { value: string; until: number }>();
  private markRegistered: () => void = () => undefined;
  private markRefused: (refusal: Error) => void = () => undefined;
  readonly registered: Promise<void> = new Promise((resolve, reject) => { this.markRegistered = resolve; this.markRefused = reject; });

  constructor(
    private parts: OidcClientSettings,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.registered.catch(ignore('whoever waits on the registration hears root\'s refusal; this branch only keeps a refusal nobody waits on yet from stopping the process'));
  }

  protected registrationRefused(reason: string): void {
    this.markRefused(new Error(reason));
  }

  protected get reach(): typeof fetch {
    return this.parts.reach ?? fetchNow;
  }

  protected useKeys(keys: ClientKeys, registration: Record<string, unknown>): void {
    this.parts = { ...this.parts, keys, registration };
    this.configured = undefined;
    this.held.clear();
  }

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

  async freshToken(resource?: string): Promise<string> {
    const now = this.now();
    const granted = await client.clientCredentialsGrant(await this.config(), { scope: this.parts.scope, ...(resource ? { resource } : {}) });
    this.held.set(resource ?? '', { value: granted.access_token, until: now + Math.max(30, (granted.expires_in ?? 60) - 30) * 1000 });
    return granted.access_token;
  }

  async register(): Promise<Record<string, unknown> | undefined> {
    try {
      await this.freshToken();
      this.markRegistered();
      return undefined;
    } catch (err) {
      if (!clientRefused(err)) throw err;
    }
    let registered: client.Configuration;
    try {
      registered = await client.dynamicClientRegistration(new URL(this.issuer), this.parts.registration as Partial<client.ClientMetadata>, await this.authentication(), { ...this.options(), initialAccessToken: this.parts.registrationCode });
    } catch (err) {
      if (errorOf(err) === 'invalid_token') throw new Error(this.parts.refused);
      throw err;
    }
    this.markRegistered();
    return registered.clientMetadata() as Record<string, unknown>;
  }

  async token(resource?: string): Promise<string> {
    const held = this.held.get(resource ?? '');
    if (held && held.until > this.now()) return held.value;
    return this.freshToken(resource);
  }

  renewsAt(resource?: string): number | undefined {
    return this.held.get(resource ?? '')?.until;
  }

  async tokenIfKnown(): Promise<string | undefined> {
    try {
      return await this.token();
    } catch (err) {
      if (clientRefused(err)) return undefined;
      throw err;
    }
  }
}

export interface MachineClientSettings {
  rootUrl: string;
  deviceId: string;
  key: string;
  registrationCode?: string | undefined;
  reach?: typeof fetch | undefined;
}

export class MachineClient extends OidcClient {
  async registerMachine(): Promise<MetricsClient> {
    return metricsClientFrom(await this.register());
  }

  async replaceKey(offer: KeyReplacement, nextKey: string): Promise<MetricsClient> {
    const keys = clientKeysFrom(nextKey);
    const registration = machineRegistration(clientPublicJwkOf(keys));
    const answer = await this.reach(offer.registrationClientUri, {
      method: 'PUT',
      headers: { authorization: `Bearer ${offer.registrationAccessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, ...registration }),
    });
    const refused = (said: string): Error => Object.assign(new Error(said), { answered: true });
    if (answer.status === 401) throw refused(KEY_REPLACEMENT_REFUSED);
    if (!answer.ok) throw refused(`root did not take this machine's new key (${answer.status}): ${(await answer.text()).trim().slice(0, 300)}`);
    this.useKeys(keys, registration);
    return metricsClientFrom(await answer.json() as Record<string, unknown>);
  }
}

export function machineClientOf(machine: MachineClientSettings): MachineClient {
  const keys = clientKeysFrom(machine.key);
  return new MachineClient({
    clientId: machine.deviceId,
    issuer: rootIssuerOf(machine.rootUrl),
    keys,
    registrationCode: machine.registrationCode ?? '',
    registration: machineRegistration(clientPublicJwkOf(keys)),
    refused: MACHINE_REGISTRATION_REFUSED,
    scope: MACHINE_SCOPE,
    reach: machine.reach,
  });
}
