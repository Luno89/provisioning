import { describe, it, expect } from 'vitest';
import { RoleConfigError, holdsAccounts, roleFromEnv, servesTenants, signsInThroughRoot } from './platform-role.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem } from '../../instances/lib/identity-token.js';

const rootKey = generateIdentityKey();
const rootPublic = publicKeyPem(identityKeysFrom(rootKey).publicKey);

describe('what this server is', () => {
  it('refuses to start without being told which of root or instance it is', () => {
    expect(() => roleFromEnv({})).toThrow(RoleConfigError);
    expect(() => roleFromEnv({ ROLE: '  ' })).toThrow('ROLE is not set; it has to be one of root, instance');
    expect(() => roleFromEnv({ ROLE: 'combined' })).toThrow('ROLE is "combined"; it has to be one of root, instance');
  });

  it('refuses to start as the hub, which is archived, naming the roles there are', () => {
    expect(() => roleFromEnv({ ROLE: 'hub', ROOT_URL: 'https://app.example.com', ROOT_PUBLIC_KEYS: rootPublic, HUB_CREDENTIAL: 'secret' })).toThrow('ROLE is "hub"; it has to be one of root, instance');
  });

  it('as root holds the accounts and the signing key, and serves no tenant', () => {
    const config = roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: Buffer.from(rootKey).toString('base64') });
    expect(config.signing?.kid).toBe(identityKeysFrom(rootKey).kid);
    expect(servesTenants(config)).toBe(false);
    expect(holdsAccounts(config)).toBe(true);
    expect(config.trusted).toBeUndefined();
  });

  it('as root refuses to start without its signing key, in production or not, and never makes one from JWT_SECRET', () => {
    expect(() => roleFromEnv({ ROLE: 'root', NODE_ENV: 'production' })).toThrow(/ROOT_IDENTITY_KEY is not set/);
    expect(() => roleFromEnv({ ROLE: 'root' })).toThrow(/ROOT_IDENTITY_KEY is not set/);
    expect(() => roleFromEnv({ ROLE: 'root', JWT_SECRET: 'an-old-single-secret-of-many-characters' })).toThrow(/ROOT_IDENTITY_KEY is not set/);
  });

  it('in production signs in through root only over https, but for a lab and an address that stays private', () => {
    const instance = { ROLE: 'instance', INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'u1', ROOT_PUBLIC_KEYS: rootPublic, NODE_ENV: 'production' };
    expect(() => roleFromEnv({ ...instance, ROOT_URL: 'http://app.nowrinkles.dev' })).toThrow(RoleConfigError);
    expect(() => roleFromEnv({ ...instance, ROOT_URL: 'http://app.nowrinkles.dev' })).toThrow(/plain http to an address on the open internet/);
    expect(roleFromEnv({ ...instance, ROOT_URL: 'https://app.nowrinkles.dev' }).instance?.rootUrl).toBe('https://app.nowrinkles.dev');
    expect(roleFromEnv({ ...instance, ROOT_URL: 'http://app.koala.internal:3001' }).instance?.rootUrl).toBe('http://app.koala.internal:3001');
    expect(roleFromEnv({ ...instance, ROOT_URL: 'http://localhost:3002' }).instance?.rootUrl).toBe('http://localhost:3002');
  });

  it('as an instance needs to know who it is, who owns it and which root it trusts — and says what is missing', () => {
    expect(() => roleFromEnv({ ROLE: 'instance', INSTANCE_ID: 'inst-1' })).toThrow('an instance needs INSTANCE_OWNER_ID, ROOT_URL, ROOT_PUBLIC_KEYS');
    const config = roleFromEnv({ ROLE: 'instance', INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'u1', ROOT_URL: 'https://app.example.com/', ROOT_PUBLIC_KEYS: rootPublic });
    expect(config.instance).toEqual({ id: 'inst-1', ownerId: 'u1', rootUrl: 'https://app.example.com' });
    expect(config.trusted?.has(identityKeysFrom(rootKey).kid)).toBe(true);
    expect(config.signing).toBeUndefined();
    expect(holdsAccounts(config)).toBe(false);
    expect(signsInThroughRoot(config.role)).toBe(true);
  });

    it('refuses a role it does not know', () => {
    expect(() => roleFromEnv({ ROLE: 'tenant' })).toThrow(RoleConfigError);
  });
});
