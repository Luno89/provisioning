import crypto from 'crypto';
import type { AccessRevocations, Database, PlatformKeys, RoleConfig } from '../../platform/index.js';
import { clientKeysFrom, OIDC_PATH } from '../lib/oidc.js';
import { RootProvider } from '../services/RootProvider.js';
import type { InstanceReach } from '../services/InstanceReach.js';
import { RootSignIn, type RootSignInDeps } from '../services/RootSignIn.js';
import { RunBearers } from '../services/RunBearers.js';
import type { BearerSignIn, ClaimSettings } from '../../platform/index.js';

const currentOf = (key: PlatformKeys['session']): string => (typeof key === 'string' ? key : key.current);

export function rootProviderFor(deps: { role: RoleConfig; publicUrl: string; keys: Pick<PlatformKeys, 'session'>; db: Database; proxied: boolean; reach: InstanceReach }): RootProvider | undefined {
  if (deps.role.role !== 'root' || !deps.role.signing) return undefined;
  return new RootProvider({
    issuer: `${deps.publicUrl.replace(/\/+$/, '')}${OIDC_PATH}`,
    signing: deps.role.signing,
    cookieKey: Buffer.from(crypto.hkdfSync('sha256', currentOf(deps.keys.session), 'koala-sign-in-provider', 'cookies', 32)).toString('hex'),
    proxied: deps.proxied,
    reach: deps.reach,
  }, deps.db);
}

export function rootSignInFor(deps: { role: RoleConfig; instanceCredential: string | undefined; keys: Pick<PlatformKeys, 'session' | 'data'>; db: Database; revocations: AccessRevocations; publicUrl: string } & Pick<RootSignInDeps, 'sessions' | 'dependency'>): RootSignIn | undefined {
  const { role } = deps;
  if (role.role !== 'instance' || !role.instance || !deps.instanceCredential) return undefined;
  return new RootSignIn({
    kind: 'instance',
    clientId: role.instance.id,
    rootUrl: role.instance.rootUrl,
    publicUrl: deps.publicUrl,
    owner: role.instance.ownerId,
    clientKeys: clientKeysFrom(currentOf(deps.keys.session)),
    dataKey: deps.keys.data,
    announce: { path: '/api/instances/sign-in-key', headers: { 'x-instance-id': role.instance.id, authorization: `Bearer ${deps.instanceCredential}` } },
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
