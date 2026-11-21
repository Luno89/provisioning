import * as client from 'openid-client';
import { createRemoteJWKSet, customFetch as joseFetch, importJWK, jwtVerify, type JWTPayload } from 'jose';
import {
  answerUnlimited, decryptValue, encryptValue, keepTrying, refusedByServer, reopening, revocationShaped, withAnswerUnlimited, type Reopening,
  type AccessRevocations, type AccessRevoked, type BrowserPerson, type BrowserSessions, type Claim, type Database, type DependencyId, type PersonThroughRoot, type SecretKey, type SignInStarted,
} from '../../platform/index.js';
import type { IdentityKeyPair } from '../lib/identity-token.js';
import type { RunToken, RunTokenRoot } from '../../engine/index.js';
import {
  claimsShaped, KOALA_CLAIMS, LOGOUT_EVENT, LOGOUT_TYP, OWNER_TOKEN_TYPE, privateJwkOf, publicJwkOf, runResourceOf, safeNextPath, SERVICE_SCOPE, TOKEN_EXCHANGE,
  SIGN_IN_SCOPES, SIGNING_ALG, type ClientKind,
} from '../lib/oidc.js';

type Store = Pick<Database, 'instances' | 'accounts'>;

export interface RootSignInSettings {
  kind: ClientKind;
  clientId: string;
  rootUrl: string;
  publicUrl: string;
  owner?: string | undefined;
  clientKeys: IdentityKeyPair;
  dataKey: SecretKey;
  announce: { path: string; headers: Record<string, string> };
}

export interface RootSignInDeps {
  store: Store;
  sessions: Pick<BrowserSessions, 'endOf'>;
  revocations: AccessRevocations;
  dependency: { failed(dependency: DependencyId, err: unknown): unknown };
}

export interface Started {
  url: string;
  started: SignInStarted;
}

export type SignedIn =
  | { ok: true; person: BrowserPerson; next?: string | undefined }
  | { ok: false; status: 400 | 401 | 403; error: string };

export type Freshened = BrowserPerson | 'kept' | 'ended';

export interface CheckedRunToken {
  personId: string;
  runId: string;
  claims: Claim[];
  space?: string | undefined;
}

const RUN_TOKEN_TYP = 'at+jwt';

const reasonOf = (err: unknown): string => {
  const known = err as { error?: unknown; error_description?: unknown; message?: unknown };
  if (typeof known.error_description === 'string' && known.error_description) return known.error_description;
  if (typeof known.error === 'string' && known.error) return known.error;
  return String(known.message ?? err);
};

type GrantedTokens = Awaited<ReturnType<typeof client.authorizationCodeGrant>>;

export class RootSignIn implements RunTokenRoot, PersonThroughRoot {
  private configured: Promise<client.Configuration> | undefined;
  private keys: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;
  private readonly refreshing = new Map<string, Promise<Freshened>>();
  private markAnnounced: () => void = () => undefined;
  readonly announced: Promise<void> = new Promise((resolve) => { this.markAnnounced = resolve; });
  private readonly store: Store;
  private readonly revocations: AccessRevocations;

  constructor(
    private readonly settings: RootSignInSettings,
    private readonly deps: RootSignInDeps,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.store = deps.store;
    this.revocations = deps.revocations;
  }

  get issuer(): string {
    return `${this.settings.rootUrl}/oidc`;
  }

  get redirectUri(): string {
    return `${this.settings.publicUrl.replace(/\/+$/, '')}/api/auth/oidc/callback`;
  }

  private config(): Promise<client.Configuration> {
    this.configured ??= (async () => {
      const key = await importJWK(privateJwkOf(this.settings.clientKeys), SIGNING_ALG) as Extract<Parameters<typeof client.PrivateKeyJwt>[0], { type: string }>;
      return client.discovery(
        new URL(this.issuer),
        this.settings.clientId,
        { id_token_signed_response_alg: SIGNING_ALG, token_endpoint_auth_signing_alg: SIGNING_ALG },
        client.PrivateKeyJwt({ key, kid: this.settings.clientKeys.kid }),
        { ...withAnswerUnlimited(), ...(this.issuer.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : {}) },
      );
    })();
    this.configured.catch(() => { this.configured = undefined; });
    return this.configured;
  }

  async announce(): Promise<void> {
    const answer = await fetch(`${this.settings.rootUrl}${this.settings.announce.path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...this.settings.announce.headers },
      body: JSON.stringify({ jwk: publicJwkOf(this.settings.clientKeys) }),
    });
    if (!answer.ok) throw new Error(`root answered ${answer.status} to this ${this.settings.kind}'s sign-in key`);
  }

  keepAnnouncing(log: (message: string) => void, again: Reopening = reopening()): void {
    void keepTrying(`root has not taken this ${this.settings.kind}'s sign-in key yet`, async () => {
      await this.announce();
      this.markAnnounced();
    }, log, again);
  }

  async start(next: unknown): Promise<Started> {
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(await this.config(), {
      redirect_uri: this.redirectUri,
      scope: SIGN_IN_SCOPES.filter((scope) => scope !== 'offline_access').join(' '),
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
      prompt: 'login',
    });
    const going = safeNextPath(next);
    return { url: url.href, started: { verifier, state, nonce, ...(going ? { next: going } : {}) } };
  }

  private personOf(tokens: GrantedTokens, sessionAt: number, kept?: BrowserPerson['tokens']): BrowserPerson | string {
    const payload = tokens.claims();
    if (!payload) return 'root sent no identity';
    const claims = payload[KOALA_CLAIMS];
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || !claimsShaped(claims)) return 'root sent an identity this server cannot read';
    if (this.settings.kind === 'instance' && payload.sub !== this.settings.owner) return 'this instance belongs to someone else';
    const refresh = tokens.refresh_token ? encryptValue(tokens.refresh_token, this.settings.dataKey) : kept?.refresh;
    const id = tokens.id_token ? encryptValue(tokens.id_token, this.settings.dataKey) : kept?.id;
    if (!refresh || !id) return 'root gave this sign-in no way to stay signed in';
    return {
      sub: payload.sub,
      email: payload.email,
      claims,
      sessionAt,
      accessExp: this.now() + (tokens.expires_in ?? 0) * 1000,
      ...(typeof payload.sid === 'string' ? { rootSid: payload.sid } : {}),
      tokens: { access: encryptValue(tokens.access_token, this.settings.dataKey), refresh, id },
    };
  }

  async callback(currentUrl: URL, started: SignInStarted | undefined): Promise<SignedIn> {
    if (typeof started?.verifier !== 'string' || typeof started.state !== 'string' || typeof started.nonce !== 'string') {
      return { ok: false, status: 400, error: 'this sign-in did not start in this browser — sign in again from here' };
    }
    let tokens: GrantedTokens;
    try {
      tokens = await client.authorizationCodeGrant(await this.config(), currentUrl, { pkceCodeVerifier: started.verifier, expectedState: started.state, expectedNonce: started.nonce, idTokenExpected: true });
    } catch (err) {
      return { ok: false, status: reasonOf(err).includes('someone else') ? 403 : 401, error: reasonOf(err) };
    }
    const person = this.personOf(tokens, this.now());
    if (typeof person === 'string') return { ok: false, status: person.includes('someone else') ? 403 : 401, error: person };
    const existing = await this.store.accounts.getUserById(person.sub);
    await this.store.accounts.saveUser({
      ...(existing ?? { twoFactorEnabled: false, createdAt: new Date(person.sessionAt).toISOString() }),
      id: person.sub,
      email: person.email,
      emailVerified: true,
    } as never);
    const next = safeNextPath(started.next);
    return { ok: true, person, ...(next ? { next } : {}) };
  }

  fresh(person: BrowserPerson): Promise<Freshened> {
    if (this.now() < person.accessExp) return Promise.resolve(person);
    const running = this.refreshing.get(person.tokens.refresh);
    if (running) return running;
    const renewing = this.refresh(person).finally(() => this.refreshing.delete(person.tokens.refresh));
    this.refreshing.set(person.tokens.refresh, renewing);
    return renewing;
  }

  private async refresh(person: BrowserPerson): Promise<Freshened> {
    let tokens: GrantedTokens;
    try {
      tokens = await client.refreshTokenGrant(await this.config(), decryptValue(person.tokens.refresh, this.settings.dataKey));
    } catch (err) {
      if (refusedByServer(err)) return 'ended';
      this.deps.dependency.failed('root', err);
      return 'kept';
    }
    const renewed = this.personOf(tokens, person.sessionAt, person.tokens);
    return typeof renewed === 'string' || renewed.sub !== person.sub ? 'ended' : renewed;
  }

  async end(person: BrowserPerson): Promise<string> {
    const config = await this.config();
    await client.tokenRevocation(config, decryptValue(person.tokens.refresh, this.settings.dataKey), { token_type_hint: 'refresh_token' });
    return client.buildEndSessionUrl(config, {
      id_token_hint: decryptValue(person.tokens.id, this.settings.dataKey),
      post_logout_redirect_uri: `${this.settings.publicUrl.replace(/\/+$/, '')}/`,
    }).href;
  }

  async backchannel(logoutToken: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    if (typeof logoutToken !== 'string') return { ok: false, error: 'send the logout token as logout_token' };
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(logoutToken, await this.rootKeys(), { issuer: this.issuer, audience: this.settings.clientId, algorithms: [SIGNING_ALG], typ: LOGOUT_TYP, requiredClaims: ['exp', 'jti'] }));
    } catch (err) {
      return { ok: false, error: `the logout token could not be checked: ${(err as Error).message}` };
    }
    const events = payload.events as Record<string, unknown> | undefined;
    if (!events || typeof events[LOGOUT_EVENT] !== 'object' || typeof payload.sub !== 'string' || !payload.sub) return { ok: false, error: 'that is not a logout token' };
    const revoking = payload.koala_revoked_at !== undefined || payload.koala_why !== undefined;
    const event: AccessRevoked = { personId: payload.sub, at: String(payload.koala_revoked_at ?? ''), because: payload.koala_why as AccessRevoked['because'] };
    if (revoking && !revocationShaped(event)) return { ok: false, error: 'that is not a logout token' };
    if (!(await this.store.instances.takeLogoutToken(String(payload.jti), new Date(Number(payload.exp) * 1000)))) return { ok: false, error: 'that logout token was already taken' };
    if (!revoking) {
      await this.deps.sessions.endOf(typeof payload.sid === 'string' ? { rootSid: payload.sid } : { sub: payload.sub });
      return { ok: true };
    }
    await this.deps.sessions.endOf({ sub: event.personId });
    const failed = await this.revocations.revoked(event);
    if (failed.length) return { ok: false, error: `not everything ${event.personId} held here could be revoked yet: ${failed.join('; ')}` };
    return { ok: true };
  }

  private runTokenOf(tokens: { access_token: string; refresh_token?: string | undefined; expires_in?: number | undefined }): RunToken {
    if (!tokens.refresh_token) throw new Error('root gave the run no way to renew its token');
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: this.now() + (tokens.expires_in ?? 0) * 1000 };
  }

  async runToken(runId: string, space?: string): Promise<RunToken> {
    if (!this.settings.owner) throw new Error(`this ${this.settings.kind} serves no owner to act for`);
    const tokens = await client.genericGrantRequest(await this.config(), TOKEN_EXCHANGE, {
      subject_token: this.settings.owner,
      subject_token_type: OWNER_TOKEN_TYPE,
      resource: runResourceOf(this.settings.clientId),
      koala_run: runId,
      ...(space ? { koala_space: space } : {}),
    }).catch((err: unknown) => { throw new Error(`root gave run ${runId} no token: ${reasonOf(err)}`); });
    return this.runTokenOf(tokens);
  }

  private rootKeys(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    this.keys ??= (async () => {
      const uri = (await this.config()).serverMetadata().jwks_uri;
      if (!uri) throw new Error('root names no keys in its discovery');
      return createRemoteJWKSet(new URL(uri), { [joseFetch]: answerUnlimited() as never });
    })();
    this.keys.catch(() => { this.keys = undefined; });
    return this.keys;
  }

  async checkRunToken(token: string): Promise<CheckedRunToken | string> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, await this.rootKeys(), { issuer: this.issuer, audience: runResourceOf(this.settings.clientId), typ: RUN_TOKEN_TYP }));
    } catch (err) {
      return `the run token could not be checked: ${(err as Error).message}`;
    }
    const claims = payload[KOALA_CLAIMS];
    const space = payload.koala_space;
    if (typeof payload.sub !== 'string' || typeof payload.koala_run !== 'string' || !claimsShaped(claims) || (space !== undefined && typeof space !== 'string')) return 'the run token does not say whose run it is';
    return { personId: payload.sub, runId: payload.koala_run, claims, ...(typeof space === 'string' ? { space } : {}) };
  }

  async renewRunToken(refreshToken: string): Promise<RunToken> {
    const tokens = await client.refreshTokenGrant(await this.config(), refreshToken, { resource: runResourceOf(this.settings.clientId) })
      .catch((err: unknown) => { throw new Error(`root renewed no run token: ${reasonOf(err)}`); });
    return this.runTokenOf(tokens);
  }

  async endRunToken(refreshToken: string): Promise<void> {
    await client.tokenRevocation(await this.config(), refreshToken, { token_type_hint: 'refresh_token' });
  }

  private held: { value: string; until: number } | undefined;

  async serviceToken(): Promise<string> {
    await this.announced;
    const now = this.now();
    if (!this.held || this.held.until <= now) {
      const granted = await client.clientCredentialsGrant(await this.config(), { scope: SERVICE_SCOPE });
      this.held = { value: granted.access_token, until: now + Math.max(30, (granted.expires_in ?? 60) - 30) * 1000 };
    }
    return this.held.value;
  }
}
