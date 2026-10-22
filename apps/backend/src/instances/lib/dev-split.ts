import { nameProblem } from './instance-names.js';
import type { InstanceRecord } from './instances.js';
import type { UserMetadata } from '../../platform/index.js';

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
  const rootUrl = webUrl(DEV_SPLIT.rootHost, DEV_SPLIT.rootWebPort);
  const instanceUrl = webUrl(input.name, DEV_SPLIT.instanceWebPort);
  const hubUrl = webUrl(DEV_SPLIT.hubHost, DEV_SPLIT.hubWebPort);
  const rootPublicKeys = Buffer.from(input.rootPublicKeys, 'utf8').toString('base64');

  return {
    rootUrl,
    instanceUrl,
    hubUrl,
    rootEnv: {
      ROLE: 'root',
      PORT: String(DEV_SPLIT.rootApiPort),
      MONGO_URI: withDatabase(input.mongoUri, DEV_SPLIT.rootDatabase),
      PUBLIC_URL: rootUrl,
      APP_URL: rootUrl,
      HUB_URL: hubUrl,
      HUB_CREDENTIAL_HASH: input.hubCredentialHash,
    },
    instanceEnv: {
      ROLE: 'instance',
      PORT: String(DEV_SPLIT.instanceApiPort),
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
      PORT: String(DEV_SPLIT.hubApiPort),
      MONGO_URI: withDatabase(input.mongoUri, DEV_SPLIT.hubDatabase),
      HUB_DATABASE: DEV_SPLIT.hubDatabase,
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
  return { ...kept, isAdmin: true } as UserMetadata;
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
  const admins = people.filter((user) => user.isAdmin).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  const owner = admins[0];
  if (!owner) throw new Error('no admin on this database to own the dev instance; sign in once with npm run dev first, or set DEV_INSTANCE_OWNER');
  return owner;
}
