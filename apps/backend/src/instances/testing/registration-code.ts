import { createHash, randomBytes } from 'node:crypto';
import { clientKeysFrom, clientPublicJwkOf, MACHINE_SCOPE, METRICS_SCOPE, metricsClientIdOf, newClientKey, rootIssuerOf, type ClientPublicJwk } from '@koala/engine-core/root-client';
import { encryptValue, type Database } from '../../platform/index.js';
import { generateIdentityKey, identityKeysFrom, type IdentityKeyPair } from '../lib/identity-token.js';
import { InstanceReach } from '../services/InstanceReach.js';
import { RootProvider } from '../services/RootProvider.js';
import { rootWebFor } from './root-web.js';
import { createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { publicJwkOf, runResourceOf, SIGNING_ALG } from '../lib/oidc.js';
import { checkMachineAccess, checkMetricsAccess, rootKeySet, type MachineAccess } from '../lib/machine-access.js';

type RootDb = Pick<Database, 'instances' | 'accounts' | 'machines'>;

const REGISTRATION_DATA = createHash('sha256').update('a-provider-that-only-makes-a-registration-code').digest('hex');

const providerAt = (root: { db: RootDb; url: string; signing: IdentityKeyPair }): RootProvider =>
  new RootProvider({ issuer: `${root.url}/oidc`, signing: root.signing, cookieKey: 'a-provider-that-only-makes-a-registration-code', proxied: false, reach: new InstanceReach({ open: true }), web: rootWebFor(root.url), dataKey: REGISTRATION_DATA }, root.db);

export const machineMetricsClient = (secret = randomBytes(32).toString('base64url')): { secret: string; since: string } =>
  ({ secret: encryptValue(secret, REGISTRATION_DATA), since: new Date().toISOString() });

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

export async function metricsAccessAt(db: RootDb, root: RootSigning, machine: { deviceId: string; koala: string }): Promise<string> {
  const rootProvider = providerAt({ db, ...root });
  const { provider } = rootProvider;
  const client = await provider.Client.find(metricsClientIdOf(machine.deviceId));
  if (!client) throw new Error(`root keeps no client for the Prometheus of the machine ${machine.deviceId}, so it gives it no token`);
  const indicator = runResourceOf(machine.koala);
  const token = new provider.ClientCredentials({ client, scope: METRICS_SCOPE });
  token.resourceServer = new provider.ResourceServer(indicator, await rootProvider.resourceServerInfo(indicator, client));
  return token.save();
}

export interface MachineAccessCheck {
  checkMachineToken(token: string): Promise<MachineAccess | string>;
  checkMetricsToken(token: string): Promise<MachineAccess | string>;
}

export const machineAccessChecked = (rootUrl: string, keys: JWTVerifyGetKey, koala: string, now: () => number): MachineAccessCheck => ({
  checkMachineToken: (token) => checkMachineAccess(token, keys, { issuer: rootIssuerOf(rootUrl), audience: runResourceOf(koala), now: now() }),
  checkMetricsToken: (token) => checkMetricsAccess(token, keys, { issuer: rootIssuerOf(rootUrl), audience: runResourceOf(koala), now: now() }),
});

export const machineAccessCheckedAt = (root: RootSigning, koala: string, now: () => number): MachineAccessCheck =>
  machineAccessChecked(root.url, createLocalJWKSet(rootPublicKeys(root)), koala, now);

export const rootPublicKeys = (root: Pick<RootSigning, 'signing'>) => ({ keys: [{ ...publicJwkOf(root.signing), alg: SIGNING_ALG, use: 'sig' }] });

export const machineAccessCheckedByServedRoot = (rootUrl: string, koala: string, served: { keysAt?: string; now?: () => number } = {}): MachineAccessCheck =>
  machineAccessChecked(rootUrl, rootKeySet(new URL(served.keysAt ?? `${rootIssuerOf(rootUrl)}/jwks`)), koala, served.now ?? (() => Date.now()));

export const machineClientsAt =(db: RootDb, url = 'http://127.0.0.1:1'): Pick<RootProvider, 'machineRegistrationCode' | 'machineCaller' | 'machineOfKey' | 'keyReplacement'> => {
  const provider = providerAt({ db, url, signing: identityKeysFrom(generateIdentityKey()) });
  return {
    machineRegistrationCode: (machine) => provider.machineRegistrationCode(machine),
    machineCaller: (token) => provider.machineCaller(token),
    machineOfKey: (token) => provider.machineOfKey(token),
    keyReplacement: (deviceId) => provider.keyReplacement(deviceId),
  };
};
