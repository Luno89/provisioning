import { describe, expect, it } from 'vitest';
import { accountOf, devSplitOwner, devSplitPlan, envFileText, readEnvFile, withDatabase } from './dev-split.js';
import type { UserMetadata } from './types.js';

const owner: UserMetadata = {
  id: 'u-1', email: 'me@example.com', googleId: 'g-1', twoFactorEnabled: false, emailVerified: true, createdAt: '2026-09-01T00:00:00Z',
  isAdmin: true, defaultModelId: 'tabby', credentials: { aws: { accessKeyId: 'secret' } } as never,
};

const plan = (name = 'dev', existing?: Parameters<typeof devSplitPlan>[0]['existing']) => devSplitPlan({
  name, owner, instanceId: 'inst-1', credential: 'cred', credentialHash: 'hashed', rootPublicKeys: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n',
  mongoUri: 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin', now: '2026-10-17T22:00:00Z', existing,
});

describe('root and an instance on one machine', () => {
  it('gives root its own database and address, and the instance everything it needs to trust root and reach it', () => {
    const { rootEnv, instanceEnv, rootUrl, instanceUrl } = plan();
    expect(rootUrl).toBe('http://koala.localhost:5174');
    expect(instanceUrl).toBe('http://dev.localhost:5173');
    expect(rootEnv).toEqual({ ROLE: 'root', PORT: '3002', MONGO_URI: 'mongodb://admin:admin@localhost:27017/koala_root?authSource=admin', PUBLIC_URL: rootUrl, APP_URL: rootUrl });
    expect(instanceEnv).toMatchObject({ ROLE: 'instance', PORT: '3001', PUBLIC_URL: instanceUrl, INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'u-1', INSTANCE_CREDENTIAL: 'cred', ROOT_URL: rootUrl });
    expect(instanceEnv.MONGO_URI).toBeUndefined();
    expect(Buffer.from(instanceEnv.ROOT_PUBLIC_KEYS!, 'base64').toString()).toContain('BEGIN PUBLIC KEY');
  });

  it('registers the instance as ready at its address, keeping when it was first made', () => {
    expect(plan().instance).toMatchObject({ id: 'inst-1', ownerId: 'u-1', url: 'http://dev.localhost:5173', name: 'dev', status: 'ready', credentialHash: 'hashed', createdAt: '2026-10-17T22:00:00Z' });
    expect(plan('dev', { id: 'inst-1', ownerId: 'u-1', url: 'x', createdAt: '2026-10-01T00:00:00Z', updatedAt: 'x' }).instance.createdAt).toBe('2026-10-01T00:00:00Z');
  });

  it('copies only the account to root, never the person\'s cloud credentials or model settings', () => {
    expect(plan().rootUser).toEqual({ id: 'u-1', email: 'me@example.com', googleId: 'g-1', twoFactorEnabled: false, emailVerified: true, createdAt: '2026-09-01T00:00:00Z', isAdmin: true });
    expect(accountOf(owner)).not.toHaveProperty('credentials');
  });

  it('refuses a name an instance could not have', () => {
    expect(() => plan('my-dev')).toThrow(/no dashes/);
    expect(() => plan('koala')).toThrow(/kept for the platform/);
  });

  it('owns the dev instance by the first admin, or the one named, and never a check\'s space', () => {
    const space = { ...owner, id: 's', isAdmin: true, createdAt: '2020-01-01', space: { person: 'u-1', checkRunId: 'c', scenarioId: 's' } };
    const later = { ...owner, id: 'u-2', email: 'two@example.com', createdAt: '2026-10-01' };
    expect(devSplitOwner([later, space, owner]).id).toBe('u-1');
    expect(devSplitOwner([later, owner], 'two@example.com').id).toBe('u-2');
    expect(() => devSplitOwner([space])).toThrow(/no admin/);
    expect(() => devSplitOwner([owner], 'nobody')).toThrow(/no one/);
  });

  it('reads back the env files it writes', () => {
    const values = { ROLE: 'instance', ROOT_URL: 'http://koala.localhost:5174', KEY: 'a=b' };
    expect(readEnvFile(envFileText(values))).toEqual(values);
  });

  it('points a Mongo address at another database, with or without one named', () => {
    expect(withDatabase('mongodb://localhost:27017', 'koala_root')).toBe('mongodb://localhost:27017/koala_root');
    expect(withDatabase('mongodb://a:b@h:1/provisioning?authSource=admin', 'koala_root')).toBe('mongodb://a:b@h:1/koala_root?authSource=admin');
    expect(() => withDatabase('postgres://x', 'y')).toThrow(/not a mongodb/);
  });
});
