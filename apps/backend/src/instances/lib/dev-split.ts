import { nameProblem } from './instance-names.js';
import type { InstanceRecord } from './instances.js';
import type { UserMetadata } from '../../platform/index.js';
import { holds, principalOf } from '../../platform/lib/permissions.js';

export const DEV_SPLIT = {
  rootDatabase: 'koala_root',
  rootHost: 'koala',
  rootApiPort: 3002,
  rootWebPort: 5175,
  instanceApiPort: 3001,
  instanceWebPort: 5173,
  hubDatabase: 'koala_hub',
  hubHost: 'hub',
  hubApiPort: 3003,
  hubWebPort: 5176,
  defaultName: 'dev',
} as const;

export interface SplitPlace {
  rootUrl: string;
  instanceUrl: string;
  hubUrl: string;
  rootApiPort: number;
  instanceApiPort: number;
  hubApiPort: number;
  rootDatabase: string;
  hubDatabase: string;
  instanceDatabase?: string | undefined;
}

export const devSplitPlace = (name: string): SplitPlace => ({
  rootUrl: webUrl(DEV_SPLIT.rootHost, DEV_SPLIT.rootWebPort),
  instanceUrl: webUrl(name, DEV_SPLIT.instanceWebPort),
  hubUrl: webUrl(DEV_SPLIT.hubHost, DEV_SPLIT.hubWebPort),
  rootApiPort: DEV_SPLIT.rootApiPort,
  instanceApiPort: DEV_SPLIT.instanceApiPort,
  hubApiPort: DEV_SPLIT.hubApiPort,
  rootDatabase: DEV_SPLIT.rootDatabase,
  hubDatabase: DEV_SPLIT.hubDatabase,
});

export interface DevSplitInput {
  name: string;
  owner: UserMetadata;
  instanceId: string;
  credential: string;
  credentialHash: string;
  hubCredential: string;
  hubCredentialHash: string;
  rootPublicKeys: string;
  mongoUri: string;
  now: string;
  existing?: InstanceRecord | undefined;
  place?: SplitPlace | undefined;
}

export interface DevSplitPlan {
  rootUrl: string;
  instanceUrl: string;
  hubUrl: string;
  rootEnv: Record<string, string>;
  instanceEnv: Record<string, string>;
  hubEnv: Record<string, string>;
  rootUser: UserMetadata;
  instance: InstanceRecord;
}

export const webUrl = (host: string, port: number): string => `http://${host}.localhost:${port}`;

export function withDatabase(uri: string, database: string): string {
  const match = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/.exec(uri);
  if (!match) throw new Error(`MONGO_URI is not a mongodb:// address: ${uri}`);
  return `${match[1]}/${database}${match[2] ?? ''}`;
}

export function devSplitPlan(input: DevSplitInput): DevSplitPlan {
  const problem = nameProblem(input.name, [DEV_SPLIT.rootHost, DEV_SPLIT.hubHost]);
  if (problem) throw new Error(`DEV_INSTANCE_NAME "${input.name}": ${problem}`);
  const place = input.place ?? devSplitPlace(input.name);
  const { rootUrl, instanceUrl, hubUrl } = place;
  const rootPublicKeys = Buffer.from(input.rootPublicKeys, 'utf8').toString('base64');

  return {
    rootUrl,
    instanceUrl,
    hubUrl,
    rootEnv: {
      ROLE: 'root',
      PORT: String(place.rootApiPort),
      MONGO_URI: withDatabase(input.mongoUri, place.rootDatabase),
      PUBLIC_URL: rootUrl,
      APP_URL: rootUrl,
      HUB_URL: hubUrl,
      HUB_CREDENTIAL_HASH: input.hubCredentialHash,
    },
    instanceEnv: {
      ROLE: 'instance',
      PORT: String(place.instanceApiPort),
      ...(place.instanceDatabase ? { MONGO_URI: withDatabase(input.mongoUri, place.instanceDatabase) } : {}),
      PUBLIC_URL: instanceUrl,
      APP_URL: instanceUrl,
      INSTANCE_ID: input.instanceId,
      INSTANCE_OWNER_ID: input.owner.id,
      INSTANCE_NAME: input.name,
      INSTANCE_CREDENTIAL: input.credential,
      ROOT_URL: rootUrl,
      ROOT_PUBLIC_KEYS: rootPublicKeys,
    },
    hubEnv: {
      ROLE: 'hub',
      PORT: String(place.hubApiPort),
      MONGO_URI: withDatabase(input.mongoUri, place.hubDatabase),
      HUB_DATABASE: place.hubDatabase,
      PUBLIC_URL: hubUrl,
      APP_URL: hubUrl,
      ROOT_URL: rootUrl,
      ROOT_PUBLIC_KEYS: rootPublicKeys,
      HUB_CREDENTIAL: input.hubCredential,
    },
    rootUser: accountOf(input.owner),
    instance: {
      ...(input.existing ?? {}),
      id: input.instanceId,
      ownerId: input.owner.id,
      url: instanceUrl,
      name: input.name,
      createdAt: input.existing?.createdAt ?? input.now,
      updatedAt: input.now,
      status: 'ready',
      detail: 'Your dev instance, run by npm run dev:split',
      credentialHash: input.credentialHash,
    },
  };
}

const ACCOUNT_FIELDS = ['id', 'email', 'passwordHash', 'githubId', 'googleId', 'twoFactorEnabled', 'twoFactorSecret', 'twoFactorPhone', 'twoFactorPreferredMethod', 'emailVerified', 'createdAt'] as const;

export function accountOf(user: UserMetadata): UserMetadata {
  const kept = Object.fromEntries(ACCOUNT_FIELDS.filter((field) => user[field] !== undefined).map((field) => [field, user[field]]));
  return { ...kept, roles: ['operator'] } as UserMetadata;
}

export function envFileText(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

export function readEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0 && !line.trimStart().startsWith('#')) values[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return values;
}

export function devSplitOwner(users: readonly UserMetadata[], wanted?: string): UserMetadata {
  const people = users.filter((user) => !user.space && !user.removal);
  if (wanted) {
    const found = people.find((user) => user.id === wanted || user.email === wanted);
    if (!found) throw new Error(`DEV_INSTANCE_OWNER "${wanted}" is no one on this database`);
    return found;
  }
  const admins = people.filter((user) => holds(principalOf(user, { role: 'combined' }), 'operator')).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  const owner = admins[0];
  if (!owner) throw new Error('no admin on this database to own the dev instance; sign in once with npm run dev first, or set DEV_INSTANCE_OWNER');
  return owner;
}
