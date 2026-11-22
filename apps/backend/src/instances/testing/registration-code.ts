import type { Database } from '../../platform/index.js';
import { generateIdentityKey, identityKeysFrom, type IdentityKeyPair } from '../lib/identity-token.js';
import { InstanceReach } from '../services/InstanceReach.js';
import { RootProvider } from '../services/RootProvider.js';
import { rootWebFor } from './root-web.js';

type RootDb = Pick<Database, 'instances' | 'accounts' | 'machines'>;

const providerAt = (root: { db: RootDb; url: string; signing: IdentityKeyPair }): RootProvider =>
  new RootProvider({ issuer: `${root.url}/oidc`, signing: root.signing, cookieKey: 'a-provider-that-only-makes-a-registration-code', proxied: false, reach: new InstanceReach({ open: true }), web: rootWebFor(root.url) }, root.db);

export const registrationCodeAt = (root: { db: RootDb; url: string; signing: IdentityKeyPair }, instance: { id: string; ownerId: string }): Promise<string> =>
  providerAt(root).registrationCode(instance);

export const machineClientsAt = (db: RootDb, url = 'http://127.0.0.1:1'): Pick<RootProvider, 'machineRegistrationCode' | 'machineCaller'> => {
  const provider = providerAt({ db, url, signing: identityKeysFrom(generateIdentityKey()) });
  return { machineRegistrationCode: (machine) => provider.machineRegistrationCode(machine), machineCaller: (token) => provider.machineCaller(token) };
};
