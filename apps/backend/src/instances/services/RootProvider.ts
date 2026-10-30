import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import Provider, { type Adapter, type AdapterPayload, type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import { SignJWT } from 'jose';
import type { AccessRevoked, Database } from '../../platform/index.js';
import type { IdentityKeyPair } from '../lib/identity-token.js';
import {
  CLAIMS_SECONDS, clientMetadata, claimsFor, hubClient, instanceClient, INTERACTION_PATH, KOALA_CLAIMS, KOALA_SCOPE, LOGOUT_TYP,
  logoutClaims, privateJwkOf, SERVICE_SCOPE, SERVICE_TOKEN_SECONDS, SESSION_SECONDS, SIGN_IN_SCOPES, SIGNING_ALG, signInRefusal,
  type ClientKind, type ClientRegistration,
} from '../lib/oidc.js';
import type { LogoutDelivery } from '../lib/sign-in-state.js';

type Store = Pick<Database, 'instances' | 'accounts'>;

export interface RootProviderSettings {
  issuer: string;
  signing: IdentityKeyPair;
  cookieKey: string;
  hubUrl?: string | undefined;
  proxied: boolean;
}

export interface ServiceCaller {
  clientId: string;
  kind: ClientKind;
}

interface KoalaClient {
  clientId: string;
  koala_kind?: ClientKind;
  koala_owner?: string;
}

const kindOf = (client: unknown): { kind: ClientKind; owner?: string | undefined } => {
  const known = client as KoalaClient;
  return { kind: known.koala_kind === 'hub' ? 'hub' : 'instance', owner: known.koala_owner };
};

export class RootProvider {
  readonly provider: Provider;
  private delivering: Promise<void> | undefined;

  constructor(
    private readonly settings: RootProviderSettings,
    private readonly store: Store,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.provider = new Provider(settings.issuer, this.configuration());
    this.provider.proxy = true;
  }

  get issuer(): string {
    return this.settings.issuer;
  }

  get proxied(): boolean {
    return this.settings.proxied;
  }

  async registration(clientId: string): Promise<ClientRegistration | undefined> {
    if (clientId === 'hub') return hubClient(this.settings.hubUrl, await this.store.instances.getHubSignInKey());
    const instance = (await this.store.instances.getInstances()).find((candidate) => candidate.id === clientId);
    return instance ? instanceClient(instance) : undefined;
  }

  private adapterFor(name: string): Adapter {
    const instances = this.store.instances;
    if (name === 'Client') {
      return {
        upsert: async () => undefined,
        find: async (id) => {
          const client = await this.registration(id);
          return client ? clientMetadata(client) as AdapterPayload : undefined;
        },
        findByUserCode: async () => undefined,
        findByUid: async () => undefined,
        consume: async () => undefined,
        destroy: async () => undefined,
        revokeByGrantId: async () => undefined,
      };
    }
    return {
      upsert: async (id, payload, expiresIn) => instances.oidcUpsert(name, id, payload as Record<string, unknown>, expiresIn),
      find: async (id) => instances.oidcFind(name, id) as Promise<AdapterPayload | undefined>,
      findByUserCode: async (code) => instances.oidcFindBy(name, 'userCode', code) as Promise<AdapterPayload | undefined>,
      findByUid: async (uid) => instances.oidcFindBy(name, 'uid', uid) as Promise<AdapterPayload | undefined>,
      consume: async (id) => instances.oidcConsume(name, id),
      destroy: async (id) => instances.oidcDestroy(name, id),
      revokeByGrantId: async (grantId) => instances.oidcRevokeGrant(grantId),
    };
  }

  private configuration(): Configuration {
    const signInScope = SIGN_IN_SCOPES.filter((scope) => scope !== 'offline_access').join(' ');
    return {
      adapter: (name: string) => this.adapterFor(name),
      clients: [],
      findAccount: async (ctx, sub) => {
        const user = await this.store.accounts.getUserById(sub);
        if (!user || user.removal) return undefined;
        const client = kindOf(ctx.oidc.client);
        return {
          accountId: sub,
          claims: async () => ({ sub, email: user.email, email_verified: user.emailVerified !== false, [KOALA_CLAIMS]: claimsFor(user, client) }),
        };
      },
      claims: { openid: ['sub'], email: ['email', 'email_verified'], [KOALA_SCOPE]: [KOALA_CLAIMS] },
      scopes: [...SIGN_IN_SCOPES, SERVICE_SCOPE],
      conformIdTokenClaims: false,
      clientDefaults: { grant_types: ['authorization_code'], id_token_signed_response_alg: SIGNING_ALG, response_types: ['code'], token_endpoint_auth_method: 'private_key_jwt' },
      clientAuthMethods: ['private_key_jwt'],
      extraClientMetadata: { properties: ['koala_kind', 'koala_owner'] },
      responseTypes: ['code'],
      pkce: { required: () => true },
      jwks: { keys: [{ ...privateJwkOf(this.settings.signing), alg: SIGNING_ALG, use: 'sig' }] as never },
      enabledJWA: { idTokenSigningAlgValues: [SIGNING_ALG], clientAuthSigningAlgValues: [SIGNING_ALG] } as never,
      cookies: { keys: [this.settings.cookieKey], long: { httpOnly: true, sameSite: 'lax' }, short: { httpOnly: true, sameSite: 'lax' } },
      features: {
        devInteractions: { enabled: false },
        clientCredentials: { enabled: true },
        revocation: { enabled: true },
        backchannelLogout: { enabled: true },
        rpInitiatedLogout: { enabled: false },
        resourceIndicators: { enabled: false },
        userinfo: { enabled: false },
        pushedAuthorizationRequests: { enabled: false },
      },
      interactions: { url: (_ctx, interaction) => `${INTERACTION_PATH}/${interaction.uid}` },
      issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
      expiresWithSession: async () => false,
      rotateRefreshToken: true,
      loadExistingGrant: async (ctx: KoaContextWithOIDC) => {
        const accountId = ctx.oidc.session?.accountId;
        const client = ctx.oidc.client;
        if (!accountId || !client || signInRefusal(kindOf(client), accountId)) return undefined;
        const existing = ctx.oidc.result?.consent?.grantId || ctx.oidc.session?.grantIdFor(client.clientId);
        const grant = (existing ? await this.provider.Grant.find(existing) : undefined) ?? new this.provider.Grant({ clientId: client.clientId, accountId });
        grant.addOIDCScope(signInScope);
        grant.addOIDCClaims(['email', 'email_verified', KOALA_CLAIMS]);
        await grant.save();
        return grant;
      },
      ttl: {
        AccessToken: CLAIMS_SECONDS,
        AuthorizationCode: 60,
        ClientCredentials: SERVICE_TOKEN_SECONDS,
        IdToken: CLAIMS_SECONDS,
        Interaction: 60 * 60,
        RefreshToken: SESSION_SECONDS,
        Session: SESSION_SECONDS,
        Grant: SESSION_SECONDS,
      },
      renderError: async (ctx, out) => {
        ctx.type = 'text/plain; charset=utf-8';
        ctx.body = `Koala could not sign you in: ${out.error_description ?? out.error}`;
      },
    };
  }

  async continueInteraction(req: IncomingMessage, res: ServerResponse, accountId: string | undefined): Promise<{ resume: string } | undefined> {
    const details = await this.provider.interactionDetails(req, res);
    if (!accountId) return { resume: `${INTERACTION_PATH}/${details.uid}` };
    const client = await this.provider.Client.find(String(details.params.client_id ?? ''));
    const refusal = client ? signInRefusal(kindOf(client), accountId) : 'root does not know what is asking you to sign in';
    if (refusal) {
      await this.provider.interactionFinished(req, res, { error: 'access_denied', error_description: refusal }, { mergeWithLastSubmission: false });
      return undefined;
    }
    if (details.prompt.name === 'login') {
      await this.provider.interactionFinished(req, res, { login: { accountId } }, { mergeWithLastSubmission: false });
      return undefined;
    }
    const grant = (details.grantId ? await this.provider.Grant.find(details.grantId) : undefined) ?? new this.provider.Grant({ clientId: client!.clientId, accountId });
    grant.addOIDCScope(SIGN_IN_SCOPES.filter((scope) => scope !== 'offline_access').join(' '));
    grant.addOIDCClaims(['email', 'email_verified', KOALA_CLAIMS]);
    await this.provider.interactionFinished(req, res, { consent: { grantId: await grant.save() } }, { mergeWithLastSubmission: true });
    return undefined;
  }

  async serviceCaller(token: string): Promise<ServiceCaller | undefined> {
    const found = await this.provider.ClientCredentials.find(token);
    if (!found?.clientId || found.isExpired || !found.scopes.has(SERVICE_SCOPE)) return undefined;
    const client = await this.provider.Client.find(found.clientId);
    if (!client) return undefined;
    return { clientId: client.clientId, kind: kindOf(client).kind };
  }

  async revoke(event: AccessRevoked): Promise<void> {
    const clientIds = await this.store.instances.oidcForgetAccount(event.personId);
    const own = (await this.store.instances.getInstances(event.personId)).filter((instance) => instance.signIn).map((instance) => instance.id);
    const hub = (await this.store.instances.getHubSignInKey()) && this.settings.hubUrl ? ['hub'] : [];
    for (const clientId of new Set([...clientIds, ...own, ...hub])) {
      const client = await this.registration(clientId);
      if (!client) continue;
      const delivery: LogoutDelivery = {
        id: crypto.randomUUID(),
        clientId,
        url: String(clientMetadata(client).backchannel_logout_uri),
        subject: event.personId,
        revokedAt: event.at,
        why: event.because,
      };
      await this.store.instances.enqueueLogout(delivery);
    }
    void this.deliverLogouts();
  }

  async logoutToken(delivery: LogoutDelivery): Promise<string> {
    const claims = logoutClaims(this.settings.issuer, delivery.clientId, { subject: delivery.subject, at: delivery.revokedAt, why: delivery.why }, Math.floor(this.now() / 1000));
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: SIGNING_ALG, typ: LOGOUT_TYP, kid: this.settings.signing.kid })
      .sign(this.settings.signing.privateKey);
  }

  deliverLogouts(): Promise<void> {
    this.delivering ??= this.deliverPending().finally(() => { this.delivering = undefined; });
    return this.delivering;
  }

  private async deliverPending(): Promise<void> {
    for (const delivery of await this.store.instances.pendingLogouts()) {
      try {
        const sent = await fetch(delivery.url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ logout_token: await this.logoutToken(delivery) }).toString(),
        });
        if (sent.ok) await this.store.instances.logoutDelivered(delivery.id);
        else await this.store.instances.logoutFailed(delivery.id, `answered ${sent.status}`, new Date(this.now()).toISOString());
      } catch (err) {
        await this.store.instances.logoutFailed(delivery.id, (err as Error).message, new Date(this.now()).toISOString());
      }
    }
  }
}
