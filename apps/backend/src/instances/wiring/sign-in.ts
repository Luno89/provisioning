import crypto from 'crypto';
import type { AccessRevocations, Database, InstanceClient, PlatformKeys, RoleConfig } from '../../platform/index.js';
import { rootIssuerOf } from '@koala/engine-core/root-client';
import { publicJwkOf, ROOT_WEB_CLIENT } from '../lib/oidc.js';
import type { IdentityKeyPair } from '../lib/identity-token.js';
import { RootProvider } from '../services/RootProvider.js';
import type { InstanceReach } from '../services/InstanceReach.js';
import { RootSignIn, type RootSignInDeps } from '../services/RootSignIn.js';
import { RunBearers } from '../services/RunBearers.js';
import type { BearerSignIn, ClaimSettings } from '../../platform/index.js';

const currentOf = (key: PlatformKeys['session']): string => (typeof key === 'string' ? key : key.current);

export function rootProviderFor(deps: { role: RoleConfig; publicUrl: string; keys: Pick<PlatformKeys, 'session' | 'data'>; db: Database; proxied: boolean; reach: InstanceReach; webKeys: IdentityKeyPair }): RootProvider | undefined {
  if (deps.role.role !== 'root' || !deps.role.signing) return undefined;
  return new RootProvider({
    issuer: rootIssuerOf(deps.publicUrl),
    signing: deps.role.signing,
    cookieKey: Buffer.from(crypto.hkdfSync('sha256', currentOf(deps.keys.session), 'koala-sign-in-provider', 'cookies', 32)).toString('hex'),
    proxied: deps.proxied,
    reach: deps.reach,
    web: { publicUrl: deps.publicUrl, key: publicJwkOf(deps.webKeys) },
    dataKey: deps.keys.data,
  }, deps.db);
}

export const toOwnProvider = (served: () => string): typeof fetch => (url, init) => {
  const asked = new URL(url instanceof Request ? url.url : url);
  const at = new URL(served());
  asked.protocol = at.protocol;
  asked.host = at.host;
  return fetch(asked, init);
};

export function rootWebSignInFor(deps: { publicUrl: string; webKeys: IdentityKeyPair; keys: Pick<PlatformKeys, 'data'>; db: Database; revocations: AccessRevocations; reach: typeof fetch } & Pick<RootSignInDeps, 'sessions' | 'dependency'>): RootSignIn {
  const rootUrl = deps.publicUrl.replace(/\/+$/, '');
  return new RootSignIn({
    kind: 'root-web',
    clientId: ROOT_WEB_CLIENT,
    rootUrl,
    publicUrl: rootUrl,
    clientKeys: deps.webKeys,
    registrationCode: '',
    dataKey: deps.keys.data,
    reach: deps.reach,
  }, { store: deps.db, sessions: deps.sessions, revocations: deps.revocations, dependency: deps.dependency });
}

export function rootSignInFor(deps: { role: RoleConfig; client: InstanceClient | undefined; keys: Pick<PlatformKeys, 'data'>; db: Database; revocations: AccessRevocations; publicUrl: string } & Pick<RootSignInDeps, 'sessions' | 'dependency'>): RootSignIn | undefined {
  const { role } = deps;
  if (role.role !== 'instance' || !role.instance || !deps.client) return undefined;
  return new RootSignIn({
    kind: 'instance',
    clientId: role.instance.id,
    rootUrl: role.instance.rootUrl,
    publicUrl: deps.publicUrl,
    owner: role.instance.ownerId,
    clientKeys: deps.client.keys,
    registrationCode: deps.client.registrationCode,
    dataKey: deps.keys.data,
  }, { store: deps.db, sessions: deps.sessions, revocations: deps.revocations, dependency: deps.dependency });
}

export function runBearersFor(signIn: RootSignIn | undefined, db: Database, claims: ClaimSettings): ((token: string) => Promise<BearerSignIn>) | undefined {
  if (!signIn) return undefined;
  const bearers = new RunBearers({ tokens: signIn, grantOfRun: (runId) => db.engine.getRunGrantOfRun(runId), accounts: db.accounts, claims });
  return (token) => bearers.signIn(token);
}

export function rootTokenOf(signIn: Pick<RootSignIn, 'serviceToken'> | undefined): (() => Promise<string>) | undefined {
  return signIn ? () => signIn.serviceToken() : undefined;
}
