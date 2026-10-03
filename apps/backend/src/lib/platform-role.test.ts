import { describe, it, expect } from 'vitest';
import { RoleConfigError, holdsAccounts, roleFromEnv, servesTenants } from './platform-role.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem } from './identity-token.js';

const rootKey = generateIdentityKey();
const rootPublic = publicKeyPem(identityKeysFrom(rootKey).publicKey);

describe('what this server is', () => {
  it('is everything at once unless told otherwise, so a dev box keeps working', () => {
    const config = roleFromEnv({});
    expect(config.role).toBe('combined');
    expect(servesTenants(config) && holdsAccounts(config)).toBe(true);
  });

  it('as root holds the accounts and the signing key, and serves no tenant', () => {
    const config = roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: Buffer.from(rootKey).toString('base64') });
    expect(config.signing?.kid).toBe(identityKeysFrom(rootKey).kid);
    expect(servesTenants(config)).toBe(false);
    expect(holdsAccounts(config)).toBe(true);
  });

  it('as root in production refuses to start without its signing key', () => {
    expect(() => roleFromEnv({ ROLE: 'root', NODE_ENV: 'production' })).toThrow(/ROOT_IDENTITY_KEY is not set/);
  });

  it('as an instance needs to know who it is, who owns it and which root it trusts — and says what is missing', () => {
    expect(() => roleFromEnv({ ROLE: 'instance', INSTANCE_ID: 'inst-1' })).toThrow('an instance needs INSTANCE_OWNER_ID, ROOT_URL, ROOT_PUBLIC_KEYS');
    const config = roleFromEnv({ ROLE: 'instance', INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'u1', ROOT_URL: 'https://app.example.com/', ROOT_PUBLIC_KEYS: rootPublic });
    expect(config.instance).toEqual({ id: 'inst-1', ownerId: 'u1', rootUrl: 'https://app.example.com' });
    expect(config.trusted?.has(identityKeysFrom(rootKey).kid)).toBe(true);
    expect(config.signing).toBeUndefined();
    expect(holdsAccounts(config)).toBe(false);
  });

  it('refuses a role it does not know', () => {
    expect(() => roleFromEnv({ ROLE: 'tenant' })).toThrow(RoleConfigError);
  });
});
