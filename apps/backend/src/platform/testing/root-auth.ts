import express from 'express';
import type { Database } from '../lib/db-interface.js';
import { createAuth, type AuthDeps, type Auth } from '../middleware/auth.js';
import { AccessRevocations } from '../services/AccessRevocations.js';
import { browserSessionsFor, type BrowserSessions } from '../services/BrowserSessions.js';
import { injectedFetch } from './injected-fetch.js';
import { testKeys } from './keys.js';
import { AuthService, devicesFor, interactionRouter } from '../../accounts/index.js';
import type { InteractionRouterDeps } from '../../accounts/routes/interaction.js';
import type { SignedInAtRoot } from '../../accounts/services/sign-in/password-at-root.js';
import { signedInWithPassword } from '../../accounts/testing/password-sign-in.js';
import { generateIdentityKey, identityKeysFrom, type IdentityKeyPair } from '../../instances/lib/identity-token.js';
import { InstanceReach } from '../../instances/services/InstanceReach.js';
import type { RootProvider } from '../../instances/services/RootProvider.js';
import type { RootSignIn } from '../../instances/services/RootSignIn.js';
import { oidcProviderRouter } from '../../instances/routes/oidc-provider.js';
import { rootClientRouter } from '../../instances/routes/sign-in.js';
import { rootProviderFor, rootWebSignInFor } from '../../instances/wiring/sign-in.js';
import { INTERACTION_PATH, OIDC_PATH } from '../../instances/lib/oidc.js';

const ROOT_SIGNING = identityKeysFrom(generateIdentityKey());
const ROOT_KEYS = testKeys('root-under-test');
const ROOT_SESSIONS = ROOT_KEYS.session;
const ROOT_DATA = ROOT_KEYS.data;

export interface RootAuthWorld {
  auth: Auth;
  sessions: BrowserSessions;
  revocations: AccessRevocations;
  provider: RootProvider;
  signIn: RootSignIn;
  publicUrl: string;
  mount(app: express.Express, accounts?: Partial<Omit<InteractionRouterDeps, 'interactions'>>): void;
  signedIn(id: string): Promise<SignedInAtRoot>;
}

export function rootAuthOver(db: Database, deps: Pick<AuthDeps, 'open'> & Partial<Pick<AuthDeps, 'publicUrl' | 'setupCode' | 'bearer'>> & { revocations?: AccessRevocations | undefined; signing?: IdentityKeyPair | undefined; instanceReach?: InstanceReach | undefined }): RootAuthWorld {
  const publicUrl = deps.publicUrl ?? 'http://localhost:3001';
  const revocations = deps.revocations ?? new AccessRevocations();
  const sessions = browserSessionsFor('root', publicUrl, { store: db.platform, secret: ROOT_SESSIONS });
  const webKeys = identityKeysFrom(generateIdentityKey());
  const provider = rootProviderFor({
    role: { role: 'root', signing: deps.signing ?? ROOT_SIGNING } as never,
    publicUrl, keys: { session: ROOT_SESSIONS, data: ROOT_DATA }, db, proxied: false, reach: deps.instanceReach ?? new InstanceReach({ open: true }), webKeys,
  })!;
  revocations.listen((revoked) => provider.revoke(revoked));
  let mounted = false;
  const own = express();
  const reach: typeof fetch = (url, init) => {
    if (!mounted) throw new Error('mount the root world on an app before anyone signs in');
    return injectedFetch(own)(url, init);
  };
  const signIn = rootWebSignInFor({ publicUrl, webKeys, keys: { data: ROOT_DATA }, db, revocations, reach, sessions, dependency: { failed: () => undefined } });
  const auth = createAuth({ db, publicUrl, role: 'root', open: deps.open, setupCode: deps.setupCode, bearer: deps.bearer, throughRoot: { sessions, signIn }, revocations });

  const mount = (app: express.Express, accounts: Partial<Omit<InteractionRouterDeps, 'interactions'>> = {}): void => {
    const authService = accounts.authService ?? new AuthService(db, { codeKey: ROOT_DATA });
    const interactions = interactionRouter({
      db, auth, codeKey: ROOT_DATA, appUrl: publicUrl,
      devices: accounts.devices ?? devicesFor({ auth, store: db.accounts, authService: authService as AuthService, revocations }),
      ...accounts,
      authService,
      interactions: provider,
    });
    if (mounted) throw new Error('the root world is mounted once');
    const oidc = oidcProviderRouter({ provider, signedIn: (req) => auth.userOf(req), interactions });
    const client = rootClientRouter({ signIn, sessions, publicUrl, landing: '/' });
    for (const served of [app, own]) {
      served.use(INTERACTION_PATH, express.json());
      served.use(OIDC_PATH, oidc);
      served.use('/api/auth', client);
    }
    mounted = true;
  };

  const signedIn = async (id: string): Promise<SignedInAtRoot> => {
    if (!mounted) throw new Error('mount the root world on an app before anyone signs in');
    return signedInWithPassword(publicUrl, db.accounts, id, injectedFetch(own));
  };

  return { auth, sessions, revocations, provider, signIn, publicUrl, mount, signedIn };
}
