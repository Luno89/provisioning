import * as client from 'openid-client';
import { carriedByOAuthState, newOAuthState, type SecretKey, type UserMetadata } from '../../../platform/index.js';
import {
  offeredProviders, providerCallbackUrl,
  type OfferedProvider, type SignInClient, type SignInProvider, type SignInProviderKind,
} from '../../lib/sign-in-providers.js';
import type { AuthService } from '../AuthService.js';
import { githubSignIn } from './github.js';
import { oidcSignIn } from './oidc.js';

export const SIGN_IN_CLIENTS: Readonly<Record<SignInProviderKind, (provider: SignInProvider) => SignInClient>> = {
  oidc: oidcSignIn,
  github: githubSignIn,
};

export type ConsumeInvite = (code: string | undefined, userId: string, isFirstUser: boolean, email?: string) => Promise<string | null>;

export type ProviderStart =
  | { kind: 'unknown' }
  | { kind: 'refused'; why: string }
  | { kind: 'started'; url: string; cookie: string };

export type ProviderFinish =
  | { kind: 'unknown' }
  | { kind: 'refused'; why: string }
  | { kind: 'signed-in'; user: UserMetadata }
  | { kind: 'second-factor'; user: UserMetadata };

export interface SignInProvidersSettings {
  providers: readonly SignInProvider[];
  publicUrl: string;
  sessionKey: SecretKey;
  accounts: Pick<AuthService, 'signInWithProvider'>;
}

const NOT_STARTED_HERE = 'This sign-in did not start here, or took longer than ten minutes; start it again';

const reasonOf = (err: unknown): string => {
  const known = err as { error?: unknown; error_description?: unknown; message?: unknown; cause?: { message?: unknown } };
  if (typeof known.error_description === 'string' && known.error_description) return known.error_description;
  if (typeof known.error === 'string' && known.error) return known.error;
  const said = String(known.message ?? err);
  const because = known.cause?.message;
  return typeof because === 'string' && because && because !== said ? `${said}: ${because}` : said;
};

export class SignInProviders {
  private readonly clients = new Map<string, SignInClient>();

  constructor(private readonly settings: SignInProvidersSettings) {}

  offered(): OfferedProvider[] {
    return offeredProviders(this.settings.providers);
  }

  private find(id: string): { provider: SignInProvider; client: SignInClient } | undefined {
    const provider = this.settings.providers.find((candidate) => candidate.id === id);
    if (!provider) return undefined;
    let made = this.clients.get(id);
    if (!made) {
      made = SIGN_IN_CLIENTS[provider.kind](provider);
      this.clients.set(id, made);
    }
    return { provider, client: made };
  }

  async start(id: string, invite: string): Promise<ProviderStart> {
    const found = this.find(id);
    if (!found) return { kind: 'unknown' };
    const verifier = client.randomPKCECodeVerifier();
    const nonce = client.randomNonce();
    const { state, cookie } = newOAuthState(invite, this.settings.sessionKey, { provider: id, verifier, nonce });
    try {
      const url = await found.client.authorizationUrl(providerCallbackUrl(this.settings.publicUrl, id), { state, verifier, nonce });
      return { kind: 'started', url: url.href, cookie };
    } catch (err) {
      return { kind: 'refused', why: `${found.provider.label} could not be asked to sign you in: ${reasonOf(err)}` };
    }
  }

  async finish(id: string, callback: URL, cookie: string | undefined, consumeInvite: ConsumeInvite): Promise<ProviderFinish> {
    const found = this.find(id);
    if (!found) return { kind: 'unknown' };
    const held = carriedByOAuthState(cookie, callback.searchParams.get('state') ?? undefined, this.settings.sessionKey);
    const verifier = held?.held.verifier;
    const nonce = held?.held.nonce;
    if (!held || held.held.provider !== id || !verifier || !nonce) return { kind: 'refused', why: NOT_STARTED_HERE };
    const label = found.provider.label;
    let identity;
    try {
      identity = await found.client.identify(callback, { state: held.state, verifier, nonce });
    } catch (err) {
      return { kind: 'refused', why: `${label} did not sign you in: ${reasonOf(err)}` };
    }
    return this.settings.accounts.signInWithProvider(
      { provider: label, issuer: found.provider.issuer, ...identity },
      held.carried || undefined,
      consumeInvite,
    );
  }
}
