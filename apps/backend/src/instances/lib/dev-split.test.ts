import { testIdentityKey, testKeyEnv } from '../../platform/testing/keys.js';
import { describe, expect, it } from 'vitest';
import { accountOf, devSplitOwner, devSplitPlan, envFileText, readEnvFile, withDatabase, type SplitPlace } from './dev-split.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { generateKeyPairSync } from 'node:crypto';
import { backendSettingsFrom } from '../../platform/lib/settings.js';
import { unreachedPlatformServices } from '../../platform/testing/platform-services.js';

const owner: UserMetadata = {
  id: 'u-1', email: 'me@example.com', signInLinks: [{ issuer: 'https://accounts.google.com', subject: 'g-1' }], twoFactorEnabled: false, emailVerified: true, createdAt: '2026-09-01T00:00:00Z',
  roles: ['operator' as const], defaultModelId: 'tabby', credentials: { aws: { accessKeyId: 'secret' } } as never,
};

const TEMPORAL = { address: '127.0.0.1:7233', namespace: 'koala-split', ca: '/etc/koala/temporal-tls/ca.crt' };
const RELEASE = { imageTag: 'dev', registry: '127.0.0.1:5001' };

const plan = (name = 'dev', existing?: Parameters<typeof devSplitPlan>[0]['existing']) => devSplitPlan({
  name, owner, instanceId: 'inst-1', credential: 'cred', credentialHash: 'hashed', hubCredential: 'hub-cred', hubCredentialHash: 'hub-hashed', rootPublicKeys: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n',
  mongoUri: 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin', now: '2026-10-17T22:00:00Z', existing, temporal: TEMPORAL, release: RELEASE, dataDir: '/repo/apps/backend/data',
});

describe('root and an instance on one machine', () => {
  it('gives root its own database and address, and the instance everything it needs to trust root and reach it', () => {
    const { rootEnv, instanceEnv, rootUrl, instanceUrl } = plan();
    expect(rootUrl).toBe('http://koala.localhost:5175');
    expect(instanceUrl).toBe('http://dev.localhost:5173');
    expect(rootEnv).toEqual({ ROLE: 'root', PORT: '3002', MONGO_URI: 'mongodb://admin:admin@localhost:27017/koala_root?authSource=admin', PUBLIC_URL: rootUrl, APP_URL: rootUrl, HUB_URL: 'http://hub.localhost:5176', HUB_CREDENTIAL_HASH: 'hub-hashed', INSTANCE_IMAGE_TAG: 'dev', INSTANCE_REGISTRY: '127.0.0.1:5001', TERRAFORM_STATE: 'local', TEMPORAL_CONNECTION_ADDRESS: '127.0.0.1:7233', TEMPORAL_NAMESPACE: 'koala-split', TEMPORAL_TLS_CA: '/etc/koala/temporal-tls/ca.crt', DATA_DIR: '/repo/apps/backend/data' });
    expect(instanceEnv).toMatchObject({ ROLE: 'instance', PORT: '3001', PUBLIC_URL: instanceUrl, INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'u-1', INSTANCE_CREDENTIAL: 'cred', ROOT_URL: rootUrl });
    expect(instanceEnv.MONGO_URI).toBeUndefined();
    expect(Buffer.from(instanceEnv.ROOT_PUBLIC_KEYS!, 'base64').toString()).toContain('BEGIN PUBLIC KEY');
  });

  it('runs the hub on its own database and address, trusting root and holding the credential root knows it by', () => {
    const { hubEnv, hubUrl, rootUrl, instanceEnv } = plan();
    expect(hubUrl).toBe('http://hub.localhost:5176');
    expect(hubEnv).toMatchObject({ ROLE: 'hub', PORT: '3003', MONGO_URI: 'mongodb://admin:admin@localhost:27017/koala_hub?authSource=admin', HUB_DATABASE: 'koala_hub', PUBLIC_URL: hubUrl, ROOT_URL: rootUrl, HUB_CREDENTIAL: 'hub-cred', ROOT_PUBLIC_KEYS: instanceEnv.ROOT_PUBLIC_KEYS });
    expect(() => plan('hub')).toThrow(/kept for the platform/);
  });

  it('registers the instance as ready at its address, keeping when it was first made', () => {
    expect(plan().instance).toMatchObject({ id: 'inst-1', ownerId: 'u-1', url: 'http://dev.localhost:5173', name: 'dev', status: 'ready', credentialHash: 'hashed', createdAt: '2026-10-17T22:00:00Z' });
    expect(plan('dev', { id: 'inst-1', ownerId: 'u-1', url: 'x', createdAt: '2026-10-01T00:00:00Z', updatedAt: 'x' }).instance.createdAt).toBe('2026-10-01T00:00:00Z');
  });

  it('copies only the account to root, never the person\'s cloud credentials or model settings', () => {
    expect(plan().rootUser).toEqual({ id: 'u-1', email: 'me@example.com', signInLinks: [{ issuer: 'https://accounts.google.com', subject: 'g-1' }], twoFactorEnabled: false, emailVerified: true, createdAt: '2026-09-01T00:00:00Z', roles: ['operator' as const] });
    expect(accountOf(owner)).not.toHaveProperty('credentials');
  });

  it('refuses a name an instance could not have', () => {
    expect(() => plan('my-dev')).toThrow(/no dashes/);
    expect(() => plan('koala')).toThrow(/kept for the platform/);
  });

  it('owns the dev instance by the first admin, or the one named, and never a check\'s space', () => {
    const space = { ...owner, id: 's', roles: ['operator' as const], createdAt: '2020-01-01', space: { person: 'u-1', checkRunId: 'c', scenarioId: 's' } };
    const later = { ...owner, id: 'u-2', email: 'two@example.com', createdAt: '2026-10-01' };
    expect(devSplitOwner([later, space, owner]).id).toBe('u-1');
    expect(devSplitOwner([later, owner], 'two@example.com').id).toBe('u-2');
    expect(() => devSplitOwner([space])).toThrow(/no admin/);
    expect(() => devSplitOwner([owner], 'nobody')).toThrow(/no one/);
  });

  it('reads back the env files it writes', () => {
    const values = { ROLE: 'instance', ROOT_URL: 'http://koala.localhost:5175', KEY: 'a=b' };
    expect(readEnvFile(envFileText(values))).toEqual(values);
  });

  it('points a Mongo address at another database, with or without one named', () => {
    expect(withDatabase('mongodb://localhost:27017', 'koala_root')).toBe('mongodb://localhost:27017/koala_root');
    expect(withDatabase('mongodb://a:b@h:1/provisioning?authSource=admin', 'koala_root')).toBe('mongodb://a:b@h:1/koala_root?authSource=admin');
    expect(() => withDatabase('postgres://x', 'y')).toThrow(/not a mongodb/);
  });
});

describe('the same split somewhere else, as a suite starts it', () => {
  const place: SplitPlace = {
    rootUrl: 'http://localhost:41001', instanceUrl: 'http://localhost:41002', hubUrl: 'http://localhost:41003',
    rootApiPort: 41001, instanceApiPort: 41002, hubApiPort: 41003,
    rootDatabase: 'koala_split_root_x', hubDatabase: 'koala_split_hub_x', instanceDatabase: 'koala_split_instance_x',
  };
  const elsewhere = devSplitPlan({
    name: 'dev', owner, instanceId: 'inst-1', credential: 'cred', credentialHash: 'hashed', hubCredential: 'hub-cred', hubCredentialHash: 'hub-hashed', rootPublicKeys: 'k',
    mongoUri: 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin', now: '2026-10-29T00:00:00Z', place, temporal: TEMPORAL, release: RELEASE, dataDir: '/repo/apps/backend/data',
  });

  it('puts each side at the place it is given, the instance on a database of its own', () => {
    expect(elsewhere.rootEnv).toMatchObject({ PORT: '41001', MONGO_URI: 'mongodb://admin:admin@localhost:27017/koala_split_root_x?authSource=admin', PUBLIC_URL: 'http://localhost:41001', HUB_URL: 'http://localhost:41003' });
    expect(elsewhere.instanceEnv).toMatchObject({ PORT: '41002', MONGO_URI: 'mongodb://admin:admin@localhost:27017/koala_split_instance_x?authSource=admin', PUBLIC_URL: 'http://localhost:41002', ROOT_URL: 'http://localhost:41001' });
    expect(elsewhere.hubEnv).toMatchObject({ PORT: '41003', HUB_DATABASE: 'koala_split_hub_x', ROOT_URL: 'http://localhost:41001' });
    expect(elsewhere.instance.url).toBe('http://localhost:41002');
  });

  it('gives root, the instance and the hub every setting their readers require, beside the services a test stack stands up', () => {
    const rootKey = String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
    const roles = devSplitPlan({
      name: 'dev', owner, instanceId: 'inst-1', credential: 'cred', credentialHash: 'hashed', hubCredential: 'hub-cred', hubCredentialHash: 'hub-hashed', rootPublicKeys: rootKey,
      mongoUri: 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin', now: '2026-10-29T00:00:00Z', place, temporal: TEMPORAL, release: RELEASE, dataDir: '/repo/apps/backend/data',
    });
    const keys = { ...testKeyEnv('dev-split'), ROOT_IDENTITY_KEY: testIdentityKey() };
    const minio = { MINIO_ENDPOINT: '127.0.0.1:9000', MINIO_ROOT_USER: 'koala', MINIO_ROOT_PASSWORD: 'koala-minio-secret', MINIO_BUCKET: 'koala' };
    expect(backendSettingsFrom({ ...keys, ...roles.rootEnv })).toMatchObject({ port: 41001, temporal: { namespace: 'koala-split' }, root: { imageTag: 'dev' } });
    expect(backendSettingsFrom({ ...keys, ...roles.instanceEnv, ...minio, ...unreachedPlatformServices(roles.instanceUrl), MACHINE_GATEWAY_PORT: '0' })).toMatchObject({ port: 41002, instance: { credential: 'cred' }, clusters: { here: { root: false } } });
    expect(backendSettingsFrom({ ...keys, ...roles.hubEnv, ...unreachedPlatformServices(roles.hubUrl) })).toMatchObject({ port: 41003, hubDatabase: 'koala_split_hub_x' });
    expect(() => backendSettingsFrom({ ...keys, ...roles.instanceEnv, ...minio, ...unreachedPlatformServices(roles.instanceUrl) })).toThrow('MACHINE_GATEWAY_PORT is not set');
  });
});
