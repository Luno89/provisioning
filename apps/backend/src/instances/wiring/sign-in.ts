import crypto from 'crypto';
import type { AccessRevocations, Database, PlatformKeys, RoleConfig } from '../../platform/index.js';
import { clientKeysFrom, HUB_CLIENT_ID, OIDC_PATH } from '../lib/oidc.js';
import { RootProvider } from '../services/RootProvider.js';
import { RootSignIn } from '../services/RootSignIn.js';

const currentOf = (key: PlatformKeys['session']): string => (typeof key === 'string' ? key : key.current);

export function rootProviderFor(deps: { role: RoleConfig; publicUrl: string; keys: Pick<PlatformKeys, 'session'>; db: Database; proxied: boolean }): RootProvider | undefined {
  if (deps.role.role !== 'root' || !deps.role.signing) return undefined;
  return new RootProvider({
    issuer: `${deps.publicUrl.replace(/\/+$/, '')}${OIDC_PATH}`,
    signing: deps.role.signing,
    cookieKey: Buffer.from(crypto.hkdfSync('sha256', currentOf(deps.keys.session), 'koala-sign-in-provider', 'cookies', 32)).toString('hex'),
    hubUrl: deps.role.hubLink?.url,
    proxied: deps.proxied,
  }, deps.db);
}

export function rootSignInFor(deps: { role: RoleConfig; env: NodeJS.ProcessEnv; keys: Pick<PlatformKeys, 'session' | 'data'>; db: Database; revocations: AccessRevocations; publicUrl: string }): RootSignIn | undefined {
  const { role } = deps;
  if (!role.trusted) return undefined;
  const common = { rootUrl: '', publicUrl: deps.publicUrl, clientKeys: clientKeysFrom(currentOf(deps.keys.session)), trusted: role.trusted, sessionKey: deps.keys.session, dataKey: deps.keys.data };
  if (role.role === 'instance' && role.instance && deps.env.INSTANCE_CREDENTIAL) {
    return new RootSignIn({
      ...common,
      kind: 'instance',
      clientId: role.instance.id,
      rootUrl: role.instance.rootUrl,
      owner: role.instance.ownerId,
      announce: { path: '/api/instances/sign-in-key', headers: { 'x-instance-id': role.instance.id, authorization: `Bearer ${deps.env.INSTANCE_CREDENTIAL}` } },
    }, deps.db, deps.revocations);
  }
  if (role.role === 'hub' && role.hub) {
    return new RootSignIn({
      ...common,
      kind: 'hub',
      clientId: HUB_CLIENT_ID,
      rootUrl: role.hub.rootUrl,
      announce: { path: '/api/hub-link/sign-in-key', headers: { authorization: `Bearer ${role.hub.credential}` } },
    }, deps.db, deps.revocations);
  }
  return undefined;
}
