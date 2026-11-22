import { clientKeysFrom, clientPublicJwkOf, MACHINE_SCOPE, newClientKey, rootIssuerOf, type ClientPublicJwk } from '@koala/engine-core/root-client';
import type { Database } from '../../platform/index.js';
import { generateIdentityKey, identityKeysFrom, type IdentityKeyPair } from '../lib/identity-token.js';
import { InstanceReach } from '../services/InstanceReach.js';
import { RootProvider } from '../services/RootProvider.js';
import { rootWebFor } from './root-web.js';
import { createLocalJWKSet, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { publicJwkOf, runResourceOf, SIGNING_ALG } from '../lib/oidc.js';
import { checkMachineAccess, type MachineAccess } from '../lib/machine-access.js';

type RootDb = Pick<Database, 'instances' | 'accounts' | 'machines'>;

const providerAt = (root: { db: RootDb; url: string; signing: IdentityKeyPair }): RootProvider =>
  new RootProvider({ issuer: `${root.url}/oidc`, signing: root.signing, cookieKey: 'a-provider-that-only-makes-a-registration-code', proxied: false, reach: new InstanceReach({ open: true }), web: rootWebFor(root.url) }, root.db);

export const registrationCodeAt = (root: { db: RootDb; url: string; signing: IdentityKeyPair }, instance: { id: string; ownerId: string }): Promise<string> =>
  providerAt(root).registrationCode(instance);

export const machineSignInKey = (): { jwk: ClientPublicJwk; since: string } => ({ jwk: clientPublicJwkOf(clientKeysFrom(newClientKey())), since: new Date().toISOString() });

export async function machineTokenAt(db: RootDb, deviceId: string, lifetime?: { seconds: number }): Promise<string> {
  const { provider } = providerAt({ db, url: 'http://127.0.0.1:1', signing: identityKeysFrom(generateIdentityKey()) });
  const client = await provider.Client.find(deviceId);
  if (!client) throw new Error(`root keeps no key for the machine ${deviceId}, so it gives it no token`);
  return new provider.ClientCredentials({ client, scope: MACHINE_SCOPE, ...(lifetime ? { expiresIn: lifetime.seconds } : {}) }).save();
}

export interface RootSigning {
  url: string;
  signing: IdentityKeyPair;
}

export async function machineAccessAt(db: RootDb, root: RootSigning, machine: { deviceId: string; koala: string }, lifetime?: { seconds: number }): Promise<string> {
  const rootProvider = providerAt({ db, ...root });
  const { provider } = rootProvider;
  const client = await provider.Client.find(machine.deviceId);
  if (!client) throw new Error(`root keeps no key for the machine ${machine.deviceId}, so it gives it no token`);
  const indicator = runResourceOf(machine.koala);
  const served = await rootProvider.resourceServerInfo(indicator, client);
  const token = new provider.ClientCredentials({ client, scope: MACHINE_SCOPE });
  token.resourceServer = new provider.ResourceServer(indicator, { ...served, ...(lifetime ? { accessTokenTTL: lifetime.seconds } : {}) });
  return token.save();
}

export interface MachineAccessCheck {
  checkMachineToken(token: string): Promise<MachineAccess | string>;
}

export const machineAccessChecked = (rootUrl: string, keys: JWTVerifyGetKey, koala: string, now: () => number): MachineAccessCheck => ({
  checkMachineToken: (token) => checkMachineAccess(token, keys, { issuer: rootIssuerOf(rootUrl), audience: runResourceOf(koala), now: now() }),
});

export const machineAccessCheckedAt = (root: RootSigning, koala: string, now: () => number): MachineAccessCheck =>
  machineAccessChecked(root.url, createLocalJWKSet({ keys: [{ ...publicJwkOf(root.signing), alg: SIGNING_ALG, use: 'sig' }] }), koala, now);

export const machineAccessCheckedByServedRoot = (rootUrl: string, koala: string): MachineAccessCheck =>
  machineAccessChecked(rootUrl, createRemoteJWKSet(new URL(`${rootIssuerOf(rootUrl)}/jwks`)), koala, () => Date.now());

export const machineClientsAt =(db: RootDb, url = 'http://127.0.0.1:1'): Pick<RootProvider, 'machineRegistrationCode' | 'machineCaller' | 'machineOfKey' | 'keyReplacement'> => {
  const provider = providerAt({ db, url, signing: identityKeysFrom(generateIdentityKey()) });
  return {
    machineRegistrationCode: (machine) => provider.machineRegistrationCode(machine),
    machineCaller: (token) => provider.machineCaller(token),
    machineOfKey: (token) => provider.machineOfKey(token),
    keyReplacement: (deviceId) => provider.keyReplacement(deviceId),
  };
};
