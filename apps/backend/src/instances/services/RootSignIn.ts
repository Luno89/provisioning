import crypto from 'crypto';
import * as client from 'openid-client';
import { importJWK, jwtVerify, type JWTPayload } from 'jose';
import {
  decryptValue, encryptValue, endsSessions, revocationShaped, signJWT, verifyJWT,
  type AccessRevocations, type AccessRevoked, type Database, type SecretKey,
} from '../../platform/index.js';
import type { IdentityKeyPair } from '../lib/identity-token.js';
import {
  CLAIMS_SECONDS, claimsShaped, KOALA_CLAIMS, LOGOUT_EVENT, LOGOUT_TYP, privateJwkOf, publicJwkOf, safeNextPath, SERVICE_SCOPE, SESSION_SECONDS,
  SIGN_IN_SCOPES, SIGNING_ALG, type ClientKind,
} from '../lib/oidc.js';
import { RevocationList, signedInSession, type SignedInSession } from '../lib/sign-in-state.js';

type Store = Pick<Database, 'instances' | 'accounts'>;

export interface RootSignInSettings {
  kind: ClientKind;
  clientId: string;
  rootUrl: string;
  publicUrl: string;
  owner?: string | undefined;
  clientKeys: IdentityKeyPair;
  trusted: ReadonlyMap<string, crypto.KeyObject>;
  sessionKey: SecretKey;
  dataKey: SecretKey;
  announce: { path: string; headers: Record<string, string> };
}

export interface Started {
  url: string;
  cookie: string;
}

export type SignedIn =
  | { ok: true; token: string; session: SignedInSession; next?: string | undefined }
  | { ok: false; status: 400 | 401 | 403; error: string };

export type Renewed = { token: string; session: SignedInSession } | 'kept' | 'ended';

export const SIGN_IN_COOKIE = 'koala_sign_in';

const reasonOf = (err: unknown): string => {
  const known = err as { error?: unknown; error_description?: unknown; message?: unknown };
  if (typeof known.error_description === 'string' && known.error_description) return known.error_description;
  if (typeof known.error === 'string' && known.error) return known.error;
  return String(known.message ?? err);
};
const SIGN_IN_COOKIE_SECONDS = 10 * 60;

export class RootSignIn {
  private configured: Promise<client.Configuration> | undefined;
  private readonly refreshing = new Map<string, Promise<Renewed>>();
  private markAnnounced: () => void = () => undefined;
  readonly announced: Promise<void> = new Promise((resolve) => { this.markAnnounced = resolve; });
  readonly revoked = new RevocationList();

  constructor(
    private readonly settings: RootSignInSettings,
    private readonly store: Store,
    private readonly revocations: AccessRevocations,
    private readonly now: () => number = () => Date.now(),
  ) {}

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
        this.issuer.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : undefined,
      );
    })();
    this.configured.catch(() => { this.configured = undefined; });
    return this.configured;
  }

  async load(): Promise<void> {
    this.revoked.load(await this.store.instances.getRevocations());
  }

  async announce(): Promise<void> {
    const answer = await fetch(`${this.settings.rootUrl}${this.settings.announce.path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...this.settings.announce.headers },
      body: JSON.stringify({ jwk: publicJwkOf(this.settings.clientKeys) }),
    });
    if (!answer.ok) throw new Error(`root answered ${answer.status} to this ${this.settings.kind}'s sign-in key`);
  }

  keepAnnouncing(log: (message: string) => void, everyMs = 10_000): void {
    const attempt = async (): Promise<void> => {
      try {
        await this.announce();
        this.markAnnounced();
      } catch (err) {
        log(`root has not taken this ${this.settings.kind}'s sign-in key yet: ${(err as Error).message}; trying again in ${Math.round(everyMs / 1000)} s`);
        setTimeout(() => { void attempt(); }, everyMs);
      }
    };
    void attempt();
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
    return { url: url.href, cookie: signJWT({ verifier, state, nonce, ...(going ? { next: going } : {}) }, this.settings.sessionKey, SIGN_IN_COOKIE_SECONDS) };
  }

  get startCookieSeconds(): number {
    return SIGN_IN_COOKIE_SECONDS;
  }

  get sessionSeconds(): number {
    return SESSION_SECONDS;
  }

  private async identity(idToken: unknown, nonce?: string): Promise<{ sub: string; email: string; claims: SignedInSession['claims'] } | string> {
    if (typeof idToken !== 'string') return 'root sent no identity';
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, (header) => {
        const key = typeof header.kid === 'string' ? this.settings.trusted.get(header.kid) : undefined;
        if (!key) throw new Error('signed by a key this server does not trust');
        return key;
      }, { issuer: this.issuer, audience: this.settings.clientId, algorithms: [SIGNING_ALG] }));
    } catch (err) {
      return `root's identity could not be checked: ${(err as Error).message}`;
    }
    if (nonce !== undefined && payload.nonce !== nonce) return 'this sign-in did not start in this browser — sign in again from here';
    const claims = payload[KOALA_CLAIMS];
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || !claimsShaped(claims)) return 'root sent an identity this server cannot read';
    if (this.settings.kind === 'instance' && payload.sub !== this.settings.owner) return 'this instance belongs to someone else';
    return { sub: payload.sub, email: payload.email, claims };
  }

  private sessionToken(session: SignedInSession): string {
    return signJWT({ ...session }, this.settings.sessionKey, SESSION_SECONDS);
  }

  async callback(currentUrl: URL, heldCookie: string | undefined): Promise<SignedIn> {
    const held = heldCookie ? verifyJWT(heldCookie, this.settings.sessionKey) : null;
    const verifier = held?.verifier;
    const state = held?.state;
    const nonce = held?.nonce;
    if (typeof verifier !== 'string' || typeof state !== 'string' || typeof nonce !== 'string') {
      return { ok: false, status: 400, error: 'this sign-in did not start in this browser — sign in again from here' };
    }
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(await this.config(), currentUrl, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
    } catch (err) {
      return { ok: false, status: reasonOf(err).includes('someone else') ? 403 : 401, error: reasonOf(err) };
    }
    const who = await this.identity(tokens.id_token, nonce);
    if (typeof who === 'string') return { ok: false, status: who.includes('someone else') ? 403 : 401, error: who };
    if (!tokens.refresh_token) return { ok: false, status: 401, error: 'root gave this sign-in no way to stay signed in' };

    const now = this.now();
    const sid = crypto.randomUUID();
    await this.store.instances.saveClientSession({
      id: sid,
      ownerId: who.sub,
      email: who.email,
      refreshToken: encryptValue(tokens.refresh_token, this.settings.dataKey),
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_SECONDS * 1000).toISOString(),
    });
    const existing = await this.store.accounts.getUserById(who.sub);
    await this.store.accounts.saveUser({
      ...(existing ?? { twoFactorEnabled: false, createdAt: new Date(now).toISOString() }),
      id: who.sub,
      email: who.email,
      emailVerified: true,
    } as never);
    const session: SignedInSession = { userId: who.sub, email: who.email, sid, sessionAt: now, freshUntil: now + CLAIMS_SECONDS * 1000, claims: who.claims };
    const next = typeof held?.next === 'string' ? safeNextPath(held.next) : undefined;
    return { ok: true, token: this.sessionToken(session), session, ...(next ? { next } : {}) };
  }

  verified(token: string | undefined): SignedInSession | undefined {
    const session = signedInSession(token ? verifyJWT(token, this.settings.sessionKey) : null);
    return session && !this.revoked.ended(session) ? session : undefined;
  }

  renew(session: SignedInSession): Promise<Renewed> {
    const running = this.refreshing.get(session.sid);
    if (running) return running;
    const renewing = this.refresh(session).finally(() => this.refreshing.delete(session.sid));
    this.refreshing.set(session.sid, renewing);
    return renewing;
  }

  private async refresh(session: SignedInSession): Promise<Renewed> {
    const stored = await this.store.instances.getClientSession(session.sid);
    if (!stored || stored.ownerId !== session.userId) return 'ended';
    let tokens: Awaited<ReturnType<typeof client.refreshTokenGrant>>;
    try {
      tokens = await client.refreshTokenGrant(await this.config(), decryptValue(stored.refreshToken, this.settings.dataKey));
    } catch (err) {
      if (err instanceof client.ResponseBodyError) {
        await this.store.instances.dropClientSession(session.sid);
        return 'ended';
      }
      return 'kept';
    }
    const who = await this.identity(tokens.id_token);
    if (typeof who === 'string' || who.sub !== session.userId) {
      await this.store.instances.dropClientSession(session.sid);
      return 'ended';
    }
    if (tokens.refresh_token) await this.store.instances.saveClientSession({ ...stored, refreshToken: encryptValue(tokens.refresh_token, this.settings.dataKey) });
    const now = this.now();
    const renewed: SignedInSession = { ...session, email: who.email, claims: who.claims, freshUntil: now + CLAIMS_SECONDS * 1000 };
    return { token: this.sessionToken(renewed), session: renewed };
  }

  async backchannel(logoutToken: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    if (typeof logoutToken !== 'string') return { ok: false, error: 'send the logout token as logout_token' };
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(logoutToken, (header) => {
        const key = typeof header.kid === 'string' ? this.settings.trusted.get(header.kid) : undefined;
        if (!key) throw new Error('signed by a key this server does not trust');
        return key;
      }, { issuer: this.issuer, audience: this.settings.clientId, algorithms: [SIGNING_ALG], typ: LOGOUT_TYP }));
    } catch (err) {
      return { ok: false, error: `the logout token could not be checked: ${(err as Error).message}` };
    }
    const events = payload.events as Record<string, unknown> | undefined;
    const event: AccessRevoked = { personId: String(payload.sub ?? ''), at: String(payload.koala_revoked_at ?? ''), because: payload.koala_why as AccessRevoked['because'] };
    if (!events || typeof events[LOGOUT_EVENT] !== 'object' || !revocationShaped(event) || !endsSessions(event)) return { ok: false, error: 'that is not a logout token' };
    await this.store.instances.recordRevocation({ subject: event.personId, before: event.at });
    this.revoked.revoke(event.personId, event.at);
    await this.store.instances.dropClientSessionsOf(event.personId);
    await this.revocations.revoked(event);
    return { ok: true };
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
