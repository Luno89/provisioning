import crypto from 'crypto';
import {
  identityKeysFrom,
  identityKeysFromSeed,
  publicKeyPem,
  trustedKeys,
  type IdentityKeyPair,
} from '../../instances/lib/identity-token.js';

export type PlatformRole = 'combined' | 'root' | 'instance' | 'hub';

export interface InstanceIdentity {
  id: string;
  ownerId: string;
  rootUrl: string;
}

export interface HubIdentity {
  rootUrl: string;
  credential: string;
}

export interface HubLink {
  url: string;
  credentialHash: string;
}

export interface RoleConfig {
  role: PlatformRole;
  signing?: IdentityKeyPair | undefined;
  trusted?: ReadonlyMap<string, crypto.KeyObject> | undefined;
  instance?: InstanceIdentity | undefined;
  hub?: HubIdentity | undefined;
  hubLink?: HubLink | undefined;
}

export class RoleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleConfigError';
  }
}

const DEV_SECRET = 'provisioning-platform-secret-12345';
const ROLES: readonly PlatformRole[] = ['combined', 'root', 'instance', 'hub'];

const pemOf = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.includes('-----BEGIN') ? trimmed.replace(/\\n/g, '\n') : Buffer.from(trimmed, 'base64').toString('utf8');
};

export const pemList = (value: string): string[] =>
  pemOf(value).split(/(?=-----BEGIN PUBLIC KEY-----)/).map((pem) => pem.trim()).filter(Boolean);

function signingKeys(env: Readonly<Record<string, string | undefined>>, production: boolean): IdentityKeyPair {
  if (env.ROOT_IDENTITY_KEY?.trim()) return identityKeysFrom(pemOf(env.ROOT_IDENTITY_KEY));
  if (production) throw new RoleConfigError('ROOT_IDENTITY_KEY is not set. Run `npm run keys -w apps/backend -- --write-env` to generate it.');
  const root = env.JWT_SECRET?.trim() || DEV_SECRET;
  return identityKeysFromSeed(Buffer.from(crypto.hkdfSync('sha256', root, 'nowrinkles-platform-keys', 'identity', 32)));
}

export function roleFromEnv(env: Readonly<Record<string, string | undefined>>): RoleConfig {
  const role = (env.ROLE?.trim() || 'combined') as PlatformRole;
  if (!ROLES.includes(role)) throw new RoleConfigError(`ROLE is "${env.ROLE}"; it has to be one of ${ROLES.join(', ')}`);
  const production = env.NODE_ENV === 'production';

  if (role === 'instance') {
    const missing = ['INSTANCE_ID', 'INSTANCE_OWNER_ID', 'ROOT_URL', 'ROOT_PUBLIC_KEYS'].filter((name) => !env[name]?.trim());
    if (missing.length > 0) throw new RoleConfigError(`an instance needs ${missing.join(', ')}`);
    return {
      role,
      trusted: trustedKeys(pemList(env.ROOT_PUBLIC_KEYS!)),
      instance: { id: env.INSTANCE_ID!.trim(), ownerId: env.INSTANCE_OWNER_ID!.trim(), rootUrl: env.ROOT_URL!.trim().replace(/\/+$/, '') },
    };
  }

  if (role === 'hub') {
    const missing = ['ROOT_URL', 'ROOT_PUBLIC_KEYS', 'HUB_CREDENTIAL'].filter((name) => !env[name]?.trim());
    if (missing.length > 0) throw new RoleConfigError(`a hub needs ${missing.join(', ')}`);
    return {
      role,
      trusted: trustedKeys(pemList(env.ROOT_PUBLIC_KEYS!)),
      hub: { rootUrl: env.ROOT_URL!.trim().replace(/\/+$/, ''), credential: env.HUB_CREDENTIAL!.trim() },
    };
  }

  const signing = signingKeys(env, production);
  const hubLink = role === 'root' && env.HUB_URL?.trim() && env.HUB_CREDENTIAL_HASH?.trim()
    ? { hubLink: { url: env.HUB_URL.trim().replace(/\/+$/, ''), credentialHash: env.HUB_CREDENTIAL_HASH.trim() } }
    : {};
  return role === 'root'
    ? { role, signing, ...hubLink }
    : { role, signing, trusted: trustedKeys([publicKeyPem(signing.publicKey)]) };
}

export const claimSettingsFrom = (config: RoleConfig): { role: PlatformRole; instanceOwnerId?: string | undefined } =>
  ({ role: config.role, ...(config.instance ? { instanceOwnerId: config.instance.ownerId } : {}) });

export const servesTenants = (config: RoleConfig): boolean => config.role !== 'root' && config.role !== 'hub';
export const holdsAccounts = (config: RoleConfig): boolean => config.role !== 'instance' && config.role !== 'hub';
export const servesHub = (config: RoleConfig): boolean => config.role === 'combined' || config.role === 'hub';
export const signsInThroughRoot = (role: PlatformRole): boolean => role === 'instance' || role === 'hub';
