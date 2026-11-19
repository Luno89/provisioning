import { describe, expect, it } from 'vitest';
import { ovhAccountOf } from './ovh-api.js';

const KEYS = { OVH_APPLICATION_KEY: 'app-key', OVH_APPLICATION_SECRET: 'app-secret', OVH_CONSUMER_KEY: 'consumer-key', OVH_SUBSIDIARY: 'FR' };

describe('an OVHcloud account from a person\'s resolved credentials', () => {
  it('is their four keys, whether they saved them or the operator\'s are theirs to use', () => {
    const account = { applicationKey: 'app-key', applicationSecret: 'app-secret', consumerKey: 'consumer-key', subsidiary: 'FR' };
    expect(ovhAccountOf({ mode: 'user', env: KEYS })).toEqual(account);
    expect(ovhAccountOf({ mode: 'env', env: KEYS })).toEqual(account);
  });

  it('is none when they have no keys, or when any of the four is missing', () => {
    expect(ovhAccountOf({ mode: 'none', env: KEYS })).toBeUndefined();
    for (const name of Object.keys(KEYS)) {
      expect(ovhAccountOf({ mode: 'user', env: Object.fromEntries(Object.entries(KEYS).filter(([key]) => key !== name)) })).toBeUndefined();
      expect(ovhAccountOf({ mode: 'user', env: { ...KEYS, [name]: '' } })).toBeUndefined();
    }
  });
});
