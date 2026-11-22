import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import Provider, { errors, type Adapter, type AdapterPayload, type ClientMetadata, type Configuration, type InteractionResults, type KoaContextWithOIDC, type ResourceServer } from 'oidc-provider';
import { servingOf } from '../lib/instances.js';
import { decodeProtectedHeader, SignJWT } from 'jose';
import { decryptValue, encryptValue, reopening, type AccessRevoked, type Database, type Reopening, type SecretKey, type Watching } from '../../platform/index.js';
import type { IdentityKeyPair } from '../lib/identity-token.js';
import {
  ACCESS_TOKEN_TYPE, basicSecretOf, CLAIMS_SECONDS, clientAt, clientMetadata, claimsFor, instanceClient, INTERACTION_PATH, KOALA_CLAIMS, KOALA_SCOPE, LOGOUT_TYP, MACHINE_TOKEN_SECONDS, OWNER_TOKEN_TYPE, RUN_SCOPE, RUN_TOKEN_SECONDS, runResourceOf, TOKEN_EXCHANGE,
  logoutClaims, privateJwkOf, registeredKeyOf, REGISTRATION_POLICY, rootWebMetadata, type PublicJwk, SERVICE_SCOPE, SERVICE_TOKEN_SECONDS, SESSION_SECONDS, SIGN_IN_SCOPES, SIGNING_ALG, signInRefusal,
  machineClientMetadata, metricsClientMetadata, type ClientAt, type ClientKind, type ClientRegistration, type RegisteringClient, type SignInKey,
} from '../lib/oidc.js';
import { MACHINE_SCOPE, machineKeyEnds, machineOfMetricsClient, METRICS_CLIENT_FIELDS, METRICS_SCOPE, metricsClientIdOf, type KeyReplacement } from '@koala/engine-core/root-client';
import type { LocalAgentDeviceMetadata } from '../../platform/index.js';
import type { LogoutDelivery } from '../lib/sign-in-state.js';
import type { InstanceReach } from './InstanceReach.js';

type Store = Pick<Database, 'instances' | 'accounts' | 'machines'>;

export interface RootProviderSettings {
  issuer: string;
  signing: IdentityKeyPair;
  cookieKey: string;
  proxied: boolean;
  reach: InstanceReach;
  web: { publicUrl: string; key: PublicJwk };
  dataKey: SecretKey;
}

export interface ServiceCaller {
  clientId: string;
  kind: 'instance';
  until: number;
}

const MACHINE_KEY_CLAIM = 'koala_key';

export interface MachineCaller {
  deviceId: string;
  ownerId: string;
  until: number;
  keyEnds: number;
}

interface KoalaClient {
  clientId: string;
  koala_kind?: ClientKind;
  koala_owner?: string;
}

const kindOf = (client: unknown): { kind: ClientKind; owner?: string | undefined } => {
  const known = client as KoalaClient;
  if (known.koala_kind !== 'instance' && known.koala_kind !== 'machine' && known.koala_kind !== 'machine-metrics' && known.koala_kind !== 'root-web') throw new errors.InvalidClient(`root does not know what kind of client ${known.clientId} is`);
  return { kind: known.koala_kind, owner: known.koala_owner };
};

const metricsClientIssued = (deviceId: string, waiting?: string): Record<string, string> => ({
  [METRICS_CLIENT_FIELDS.id]: metricsClientIdOf(deviceId),
  [METRICS_CLIENT_FIELDS.secret]: waiting ?? crypto.randomBytes(32).toString('base64url'),
});

const rotating = (): boolean => Boolean(Provider.ctx?.oidc?.entities?.RegistrationAccessToken);

const assertionKid = (ctx: KoaContextWithOIDC | undefined): string | undefined => {
  const assertion = (ctx?.oidc?.params as { client_assertion?: unknown } | undefined)?.client_assertion;
  return typeof assertion === 'string' ? decodeProtectedHeader(assertion).kid : undefined;
};

export type InteractionHeld = Record<string, unknown>;

export interface PendingInteraction {
  uid: string;
  held: InteractionHeld;
}

export class RootProvider {
  readonly provider: Provider;
  private delivering: Promise<void> | undefined;
  private again: Reopening | undefined;
  private nextDelivery: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly settings: RootProviderSettings,
    private readonly store: Store,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.provider = new Provider(settings.issuer, this.configuration());
    this.provider.proxy = true;
    this.provider.registerGrantType(TOKEN_EXCHANGE, (ctx) => this.exchange(ctx), ['subject_token', 'subject_token_type', 'resource', 'koala_run', 'koala_space']);
  }

  private runServer(resource: string): InstanceType<Provider['ResourceServer']> {
    return new this.provider.ResourceServer(resource, { audience: resource, scope: RUN_SCOPE, accessTokenFormat: 'jwt', accessTokenTTL: RUN_TOKEN_SECONDS, jwt: { sign: { alg: SIGNING_ALG } } });
  }

  async resourceServerInfo(indicator: string, client: unknown): Promise<ResourceServer> {
    const kind = kindOf(client);
    if (kind.kind === 'machine' || kind.kind === 'machine-metrics') {
      const koala = kind.owner ? servingOf(await this.store.instances.getInstances(kind.owner)) : undefined;
      if (!koala || indicator !== runResourceOf(koala.id)) throw new errors.InvalidTarget('a machine takes tokens only for its owner\'s Koala');
      return { audience: indicator, scope: kind.kind === 'machine' ? MACHINE_SCOPE : METRICS_SCOPE, accessTokenFormat: 'jwt', accessTokenTTL: MACHINE_TOKEN_SECONDS, jwt: { sign: { alg: SIGNING_ALG } } };
    }
    if (indicator !== runResourceOf((client as KoalaClient).clientId)) throw new errors.InvalidTarget('root serves no such resource');
    return { audience: indicator, scope: RUN_SCOPE, accessTokenFormat: 'jwt', accessTokenTTL: RUN_TOKEN_SECONDS, jwt: { sign: { alg: SIGNING_ALG } } };
  }

  private async liveSignIn(accountId: string, clientId: string): Promise<boolean> {
    const now = Math.floor(this.now() / 1000);
    return (await this.store.instances.oidcGrantsOf(accountId)).some((grant) => grant.clientId === clientId && Number(grant.exp ?? 0) > now && grant.resources === undefined);
  }

  private async exchange(ctx: KoaContextWithOIDC): Promise<void> {
    const client = ctx.oidc.client;
    if (!client) throw new errors.InvalidClient('the client could not be identified');
    const params = ctx.oidc.params as Record<string, unknown>;
    if (params.subject_token_type !== OWNER_TOKEN_TYPE) throw new errors.CustomOIDCProviderError('invalid_request', `a run token is exchanged for ${OWNER_TOKEN_TYPE}`);
    const resource = runResourceOf(client.clientId);
    if (params.resource !== resource) throw new errors.CustomOIDCProviderError('invalid_target', 'a run token is only for the instance asking for it');
    const runId = params.koala_run;
    if (typeof runId !== 'string' || !runId) throw new errors.CustomOIDCProviderError('invalid_request', 'name the run as koala_run');
    const space = params.koala_space;
    if (space !== undefined && (typeof space !== 'string' || !space)) throw new errors.CustomOIDCProviderError('invalid_request', 'name the check space as koala_space, or leave it out');
    const kind = kindOf(client);
    const accountId = String(params.subject_token ?? '');
    if (!accountId || kind.owner !== accountId) throw new errors.CustomOIDCProviderError('invalid_grant', 'an instance asks run tokens only for its owner');
    const user = await this.store.accounts.getUserById(accountId);
    if (!user || user.removal) throw new errors.CustomOIDCProviderError('invalid_grant', 'that account is not there');
    if (!(await this.liveSignIn(accountId, client.clientId))) throw new errors.CustomOIDCProviderError('invalid_grant', 'its owner is not signed in to this Koala: they sign in again, and their runs can act for them');

    const grant = new this.provider.Grant({ accountId, clientId: client.clientId });
    grant.addResourceScope(resource, RUN_SCOPE);
    const grantId = await grant.save();
    await this.store.instances.oidcUpsert('KoalaRun', grantId, { grantId, accountId, clientId: client.clientId, runId, ...(space ? { space } : {}), claims: claimsFor(user, kind) }, SESSION_SECONDS);

    const at = new this.provider.AccessToken({ accountId, client, grantId, gty: 'token_exchange', scope: RUN_SCOPE });
    at.resourceServer = this.runServer(resource);
    const accessToken = await at.save();
    const rt = new this.provider.RefreshToken({ accountId, client, grantId, gty: 'token_exchange', resource, rotations: 0, scope: RUN_SCOPE });
    const refreshToken = await rt.save();
    ctx.body = { access_token: accessToken, issued_token_type: ACCESS_TOKEN_TYPE, token_type: 'Bearer', expires_in: at.expiration, refresh_token: refreshToken, scope: RUN_SCOPE };
  }

  private async codeFor(client: RegisteringClient & { ownerId: string }): Promise<string> {
    const code = await new this.provider.InitialAccessToken({ policies: [REGISTRATION_POLICY] }).save();
    await this.store.instances.oidcBindRegistration(code, client);
    return code;
  }

  registrationCode(instance: { id: string; ownerId: string }): Promise<string> {
    return this.codeFor({ kind: 'instance', ...instance });
  }

  machineRegistrationCode(machine: { id: string; ownerId: string }): Promise<string> {
    return this.codeFor({ kind: 'machine', ...machine });
  }

  private async device(id: string): Promise<LocalAgentDeviceMetadata | undefined> {
    return (await this.store.machines.getLocalAgentDevices()).find((candidate) => candidate.id === id);
  }

  private async saveMachineClient(id: string, signIn: SignInKey, secret: string, rotated: boolean): Promise<void> {
    const device = await this.device(id);
    const heldSecret = device?.metricsClient ? decryptValue(device.metricsClient.secret, this.settings.dataKey) : undefined;
    const metricsClient = heldSecret === secret && device?.metricsClient ? device.metricsClient : { secret: encryptValue(secret, this.settings.dataKey), since: new Date(this.now()).toISOString() };
    if (!rotated) {
      await this.store.machines.updateLocalAgentDevice(id, { set: { signIn, metricsClient }, unset: ['previousSignIn', 'previousMetricsClient'] });
      return;
    }
    const previousSignIn = device?.previousSignIn ?? (device?.signIn && device.signIn.jwk.kid !== signIn.jwk.kid ? device.signIn : undefined);
    const previousMetricsClient = device?.previousMetricsClient ?? (device?.metricsClient && heldSecret !== secret ? device.metricsClient : undefined);
    await this.store.machines.updateLocalAgentDevice(id, { set: { signIn, metricsClient, ...(previousSignIn ? { previousSignIn } : {}), ...(previousMetricsClient ? { previousMetricsClient } : {}) } });
  }

  private presentedMetricsSecret(device: LocalAgentDeviceMetadata): string | undefined {
    if (!device.metricsClient) return undefined;
    const current = decryptValue(device.metricsClient.secret, this.settings.dataKey);
    if (!device.previousMetricsClient) return current;
    const previous = decryptValue(device.previousMetricsClient.secret, this.settings.dataKey);
    return basicSecretOf(Provider.ctx?.get('authorization')) === previous ? previous : current;
  }

  private async metricsSecretUsed(ctx: KoaContextWithOIDC | undefined, clientId: string | undefined): Promise<void> {
    const metricsOf = clientId ? machineOfMetricsClient(clientId) : undefined;
    const device = metricsOf ? await this.device(metricsOf) : undefined;
    if (!device?.metricsClient || !device.previousMetricsClient) return;
    if (basicSecretOf(ctx?.get('authorization')) !== decryptValue(device.metricsClient.secret, this.settings.dataKey)) return;
    await this.store.machines.updateLocalAgentDevice(device.id, { unset: ['previousMetricsClient'] });
  }

  private async registering(ctx: KoaContextWithOIDC, properties: Record<string, unknown>): Promise<void> {
    const key = registeredKeyOf(properties);
    if (!key) throw new errors.InvalidClientMetadata('register one Ed25519 public key with its kid');
    const replacing = ctx.oidc.entities.RegistrationAccessToken;
    if (replacing) {
      await replacing.destroy();
      const device = await this.device(replacing.clientId ?? '');
      if (!device?.signIn) throw new errors.InvalidToken('root keeps no key for this machine, so there is none to replace');
      const waiting = device.previousMetricsClient && device.metricsClient ? decryptValue(device.metricsClient.secret, this.settings.dataKey) : undefined;
      Object.assign(properties, machineClientMetadata({ id: device.id, ownerId: device.ownerId, key }), metricsClientIssued(device.id, waiting));
      return;
    }
    const code = ctx.oidc.entities.InitialAccessToken?.jti;
    const taken = code ? await this.store.instances.oidcTakeRegistration(code) : undefined;
    if (!taken) throw new errors.InvalidToken('this registration code was used already, or a newer one replaced it');
    if (taken.kind === 'machine') {
      const device = await this.device(taken.id);
      if (!device) throw new errors.InvalidToken('the machine this registration code was made for is gone');
      Object.assign(properties, machineClientMetadata({ id: device.id, ownerId: device.ownerId, key }), metricsClientIssued(device.id));
      return;
    }
    const instance = (await this.store.instances.getInstances()).find((candidate) => candidate.id === taken.id);
    if (!instance) throw new errors.InvalidToken('the Koala this registration code was made for is gone');
    Object.assign(properties, {
      client_id: instance.id,
      koala_kind: 'instance',
      koala_owner: instance.ownerId,
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: { keys: [{ ...key, alg: SIGNING_ALG, use: 'sig' }] },
    });
  }

  get issuer(): string {
    return this.settings.issuer;
  }

  get proxied(): boolean {
    return this.settings.proxied;
  }

  async registration(clientId: string): Promise<ClientRegistration | undefined> {
    const instance = (await this.store.instances.getInstances()).find((candidate) => candidate.id === clientId);
    return instance ? instanceClient(instance) : undefined;
  }

  private async addressedClient(clientId: string): Promise<ClientRegistration | undefined> {
    const instances = this.store.instances;
    const read = async (): Promise<ClientAt> => clientAt((await instances.getInstances()).find((candidate) => candidate.id === clientId));
    const first = await read();
    if (!first || 'client' in first) return first?.client;
    return new Promise((resolve, reject) => {
      let settled = false;
      let watching: Watching | undefined;
      const end = (): void => {
        settled = true;
        void watching?.close().catch((err: Error) => console.warn(`[sign-in] following ${clientId} for its address could not stop: ${err.message}`));
      };
      const settle = (at: ClientAt): void => {
        if (settled || (at && 'waiting' in at)) return;
        end();
        resolve(at?.client);
      };
      watching = instances.followInstance(clientId, (written) => settle(clientAt(written)));
      watching.ready.then(read).then(settle, (err: unknown) => {
        if (settled) return;
        end();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private adapterFor(name: string): Adapter {
    const instances = this.store.instances;
    if (name === 'Client') {
      return {
        upsert: async (id, payload) => {
          const key = registeredKeyOf(payload as Record<string, unknown>);
          if (!key) throw new errors.InvalidClientMetadata('register one Ed25519 public key with its kid');
          const sinceFor = (held: SignInKey | undefined): string => (held?.jwk.kid === key.kid ? held.since : new Date(this.now()).toISOString());
          if ((payload as KoalaClient).koala_kind === 'machine') {
            const secret = (payload as Record<string, unknown>)[METRICS_CLIENT_FIELDS.secret];
            if (typeof secret !== 'string' || !secret) throw new errors.InvalidClientMetadata('root registers a machine only with a client for its Prometheus');
            await this.saveMachineClient(id, { jwk: key, since: sinceFor((await this.device(id))?.signIn) }, secret, rotating());
            return;
          }
          const held = (await instances.getInstances()).find((candidate) => candidate.id === id)?.signIn;
          await instances.saveSignInKey(id, { jwk: key, since: sinceFor(held) });
        },
        find: async (id) => {
          const metricsOf = machineOfMetricsClient(id);
          if (metricsOf) {
            const device = await this.device(metricsOf);
            const secret = device ? this.presentedMetricsSecret(device) : undefined;
            return device && secret ? metricsClientMetadata({ id: device.id, ownerId: device.ownerId, secret }) as AdapterPayload : undefined;
          }
          const client = await this.addressedClient(id);
          if (client) return clientMetadata(client) as AdapterPayload;
          const device = await this.device(id);
          return device?.signIn ? machineClientMetadata({ id: device.id, ownerId: device.ownerId, key: device.signIn.jwk, previous: device.previousSignIn?.jwk }) as AdapterPayload : undefined;
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
      fetch: (url, options) => this.providerFetch(url, options),
      clients: [rootWebMetadata(this.settings.web.publicUrl, this.settings.web.key) as ClientMetadata],
      findAccount: async (ctx, sub) => {
        const user = await this.store.accounts.getUserById(sub);
        if (!user || user.removal) return undefined;
        const client = ctx.oidc.client ? kindOf(ctx.oidc.client) : undefined;
        return {
          accountId: sub,
          claims: async () => ({ sub, email: user.email, email_verified: user.emailVerified !== false, ...(client ? { [KOALA_CLAIMS]: claimsFor(user, client) } : {}) }),
        };
      },
      claims: { openid: ['sub'], email: ['email', 'email_verified'], [KOALA_SCOPE]: [KOALA_CLAIMS] },
      scopes: [...SIGN_IN_SCOPES, SERVICE_SCOPE, RUN_SCOPE, MACHINE_SCOPE, METRICS_SCOPE],
      conformIdTokenClaims: false,
      clientDefaults: { grant_types: ['authorization_code'], id_token_signed_response_alg: SIGNING_ALG, response_types: ['code'], token_endpoint_auth_method: 'private_key_jwt' },
      clientAuthMethods: ['private_key_jwt', 'client_secret_basic'],
      extraClientMetadata: { properties: ['koala_kind', 'koala_owner', METRICS_CLIENT_FIELDS.id, METRICS_CLIENT_FIELDS.secret] },
      responseTypes: ['code'],
      pkce: { required: () => true },
      jwks: { keys: [{ ...privateJwkOf(this.settings.signing), alg: SIGNING_ALG, use: 'sig' }] as never },
      enabledJWA: { idTokenSigningAlgValues: [SIGNING_ALG], clientAuthSigningAlgValues: [SIGNING_ALG] } as never,
      cookies: { keys: [this.settings.cookieKey], long: { httpOnly: true, sameSite: 'lax' }, short: { httpOnly: true, sameSite: 'lax' } },
      features: {
        devInteractions: { enabled: false },
        claimsParameter: { enabled: true },
        clientCredentials: { enabled: true },
        revocation: { enabled: true },
        backchannelLogout: { enabled: true },
        rpInitiatedLogout: {
          enabled: true,
          logoutSource: async (ctx, form) => {
            ctx.type = 'html';
            if (ctx.oidc.client && kindOf(ctx.oidc.client).kind === 'root-web') {
              ctx.body = `<!doctype html><meta charset="utf-8"><title>Signing out of Koala</title><body onload="document.forms['op.logoutForm'].submit()" style="font-family:system-ui;padding:2rem">${form.replace('</form>', '<input type="hidden" name="logout" value="yes"/></form>')}<p>Signing this browser out of Koala…</p></body>`;
              return;
            }
            ctx.body = `<!doctype html><meta charset="utf-8"><title>Sign out of Koala</title><body style="font-family:system-ui;padding:2rem">${form}<p>You signed out of your Koala. Sign this browser out of Koala everywhere too?</p><button autofocus type="submit" form="op.logoutForm" name="logout" value="yes">Sign out everywhere in this browser</button></body>`;
          },
          postLogoutSuccessSource: async (ctx) => {
            ctx.type = 'html';
            ctx.body = '<!doctype html><meta charset="utf-8"><title>Signed out of Koala</title><body style="font-family:system-ui;padding:2rem"><p>This browser is signed out of Koala.</p></body>';
          },
        },
        resourceIndicators: {
          enabled: true,
          defaultResource: async () => undefined,
          useGrantedResource: async () => true,
          getResourceServerInfo: async (_ctx, indicator, client) => this.resourceServerInfo(indicator, client),
        },
        registration: {
          enabled: true,
          initialAccessToken: true,
          issueRegistrationAccessToken: false,
          policies: { [REGISTRATION_POLICY]: async (ctx, properties) => this.registering(ctx, properties as Record<string, unknown>) },
        },
        registrationManagement: { enabled: true, rotateRegistrationAccessToken: false },
        userinfo: { enabled: false },
        pushedAuthorizationRequests: { enabled: false },
      },
      interactions: { url: (_ctx, interaction) => `${INTERACTION_PATH}/${interaction.uid}` },
      issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
      expiresWithSession: async () => false,
      extraTokenClaims: async (ctx, token) => {
        if (token.kind === 'ClientCredentials') {
          await this.metricsSecretUsed(ctx, token.clientId);
          return this.machineKeyClaim(ctx, token.clientId);
        }
        if (token.kind !== 'AccessToken' || !token.grantId) return undefined;
        const run = await this.store.instances.oidcFind('KoalaRun', token.grantId);
        if (!run) return undefined;
        return { koala_run: run.runId, ...(run.space ? { koala_space: run.space } : {}), [KOALA_CLAIMS]: run.claims, act: { sub: run.clientId } };
      },
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
        AccessToken: (_ctx, token) => token.resourceServer?.accessTokenTTL ?? CLAIMS_SECONDS,
        AuthorizationCode: 60,
        ClientCredentials: (_ctx, token) => token.resourceServer?.accessTokenTTL ?? SERVICE_TOKEN_SECONDS,
        IdToken: CLAIMS_SECONDS,
        Interaction: 60 * 60,
        RegistrationAccessToken: SERVICE_TOKEN_SECONDS,
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

  private async resultFor(details: Awaited<ReturnType<Provider['interactionDetails']>>, accountId: string): Promise<{ result: InteractionResults; merge: boolean }> {
    const client = await this.provider.Client.find(String(details.params.client_id ?? ''));
    const refusal = client ? signInRefusal(kindOf(client), accountId) : 'root does not know what is asking you to sign in';
    if (refusal) return { result: { error: 'access_denied', error_description: refusal }, merge: false };
    if (details.prompt.name === 'login') return { result: { login: { accountId } }, merge: false };
    const grant = (details.grantId ? await this.provider.Grant.find(details.grantId) : undefined) ?? new this.provider.Grant({ clientId: client!.clientId, accountId });
    grant.addOIDCScope(SIGN_IN_SCOPES.filter((scope) => scope !== 'offline_access').join(' '));
    grant.addOIDCClaims(['email', 'email_verified', KOALA_CLAIMS]);
    return { result: { consent: { grantId: await grant.save() } }, merge: true };
  }

  async continueInteraction(req: IncomingMessage, res: ServerResponse, accountId: string | undefined): Promise<{ resume: string } | undefined> {
    const details = await this.provider.interactionDetails(req, res);
    if (!accountId) return { resume: `${INTERACTION_PATH}/${details.uid}` };
    const { result, merge } = await this.resultFor(details, accountId);
    await this.provider.interactionFinished(req, res, result, { mergeWithLastSubmission: merge });
    return undefined;
  }

  async pendingInteraction(req: IncomingMessage, res: ServerResponse): Promise<PendingInteraction | undefined> {
    try {
      const details = await this.provider.interactionDetails(req, res);
      const held = (details.result as { koala?: unknown } | undefined)?.koala;
      return { uid: details.uid, held: held && typeof held === 'object' ? held as InteractionHeld : {} };
    } catch (err) {
      if (err instanceof errors.SessionNotFound) return undefined;
      throw err;
    }
  }

  async holdInInteraction(req: IncomingMessage, res: ServerResponse, held: InteractionHeld): Promise<void> {
    const details = await this.provider.interactionDetails(req, res);
    details.result = { koala: held };
    await details.persist();
  }

  async finishInteraction(req: IncomingMessage, res: ServerResponse, accountId: string): Promise<string> {
    const details = await this.provider.interactionDetails(req, res);
    const { result, merge } = await this.resultFor(details, accountId);
    return this.provider.interactionResult(req, res, result, { mergeWithLastSubmission: merge });
  }

  async serviceCaller(token: string): Promise<ServiceCaller | undefined> {
    const found = await this.provider.ClientCredentials.find(token);
    if (!found?.clientId || found.exp === undefined || found.isExpired || !found.scopes.has(SERVICE_SCOPE)) return undefined;
    const client = await this.provider.Client.find(found.clientId);
    if (!client || kindOf(client).kind !== 'instance') return undefined;
    return { clientId: client.clientId, kind: 'instance', until: found.exp * 1000 };
  }

  private async machineKeyClaim(ctx: KoaContextWithOIDC | undefined, clientId: string | undefined): Promise<{ [MACHINE_KEY_CLAIM]: string } | undefined> {
    const authenticated = ctx?.oidc?.client;
    const client = authenticated?.clientId === clientId ? authenticated : clientId ? await this.provider.Client.find(clientId) : undefined;
    if (!client || kindOf(client).kind !== 'machine') return undefined;
    const device = await this.device(client.clientId);
    if (!device?.signIn) return undefined;
    const kid = authenticated?.clientId === client.clientId ? assertionKid(ctx) : device.signIn.jwk.kid;
    if (kid === device.signIn.jwk.kid && device.previousSignIn) await this.store.machines.updateLocalAgentDevice(device.id, { unset: ['previousSignIn'] });
    return kid ? { [MACHINE_KEY_CLAIM]: kid } : undefined;
  }

  async machineOfKey(token: string): Promise<MachineCaller | undefined> {
    const found = await this.provider.ClientCredentials.find(token);
    if (!found?.clientId || found.exp === undefined || found.isExpired || !found.scopes.has(MACHINE_SCOPE)) return undefined;
    const client = await this.provider.Client.find(found.clientId);
    if (!client) return undefined;
    const kind = kindOf(client);
    if (kind.kind !== 'machine' || !kind.owner) return undefined;
    const tokenKey = (found.extra as Record<string, unknown> | undefined)?.[MACHINE_KEY_CLAIM];
    const device = await this.device(client.clientId);
    const since = [device?.signIn, device?.previousSignIn].find((held) => held && tokenKey === held.jwk.kid)?.since;
    if (!tokenKey || !since) return undefined;
    return { deviceId: client.clientId, ownerId: kind.owner, until: found.exp * 1000, keyEnds: machineKeyEnds(since) };
  }

  async machineCaller(token: string): Promise<MachineCaller | undefined> {
    const caller = await this.machineOfKey(token);
    return caller && caller.keyEnds > this.now() ? caller : undefined;
  }

  async keyReplacement(deviceId: string): Promise<KeyReplacement> {
    const client = await this.provider.Client.find(deviceId);
    if (!client || kindOf(client).kind !== 'machine') throw new Error(`root keeps no key for the machine ${deviceId}, so there is none to replace`);
    const registrationAccessToken = await Object.assign(new this.provider.RegistrationAccessToken(), { clientId: deviceId, policies: [REGISTRATION_POLICY] }).save();
    return { registrationAccessToken, registrationClientUri: `${this.settings.issuer}/reg/${encodeURIComponent(deviceId)}` };
  }

  async revoke(event: AccessRevoked): Promise<void> {
    const clientIds = await this.store.instances.oidcForgetAccount(event.personId, event.kept?.rootSid);
    const own = (await this.store.instances.getInstances(event.personId)).filter((instance) => instance.signIn).map((instance) => instance.id);
    for (const clientId of new Set([...clientIds, ...own])) {
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
    void this.deliverAndSchedule();
  }

  keepDelivering(again: Reopening = reopening()): void {
    this.again = again;
    void this.deliverAndSchedule();
  }

  stopDelivering(): void {
    clearTimeout(this.nextDelivery);
    this.again = undefined;
  }

  private async deliverAndSchedule(): Promise<void> {
    await this.deliverLogouts();
    const again = this.again;
    if (!again) return;
    clearTimeout(this.nextDelivery);
    if (!(await this.store.instances.pendingLogouts()).length) {
      again.reset();
      return;
    }
    this.nextDelivery = again.later(() => { void this.deliverAndSchedule(); });
    this.nextDelivery.unref?.();
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

  private async providerFetch(url: string | URL | Request, options: (RequestInit & { dispatcher?: unknown }) | undefined): Promise<Response> {
    const { signal: _deadline, dispatcher: _guard, ...init } = options ?? {};
    const origin = new URL(url instanceof Request ? url.url : url).origin;
    const instance = (await this.store.instances.getInstances()).find((candidate) => URL.canParse(candidate.url ?? '') && new URL(candidate.url!).origin === origin);
    return this.settings.reach.fetchFor(instance ?? {})(url, init);
  }

  private async deliveryFetch(delivery: LogoutDelivery): Promise<typeof fetch> {
    const instance = (await this.store.instances.getInstances()).find((candidate) => candidate.id === delivery.clientId);
    return this.settings.reach.fetchFor(instance ?? {});
  }

  private async deliverPending(): Promise<void> {
    for (const delivery of await this.store.instances.pendingLogouts()) {
      try {
        const sent = await (await this.deliveryFetch(delivery))(delivery.url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ logout_token: await this.logoutToken(delivery) }).toString(),
        });
        if (sent.ok) await this.store.instances.logoutDelivered(delivery.id);
        else await this.store.instances.logoutFailed(delivery.id, `answered ${sent.status}`, new Date(this.now()).toISOString());
      } catch (err) {
        await this.store.instances.logoutFailed(delivery.id, failureOf(err), new Date(this.now()).toISOString());
      }
    }
  }
}

function failureOf(err: unknown): string {
  const failure = err as Error & { cause?: { code?: string; message?: string } };
  const cause = failure.cause?.code ?? failure.cause?.message;
  return cause ? `${failure.message}: ${cause}` : failure.message;
}
