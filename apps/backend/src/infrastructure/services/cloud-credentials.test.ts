import { describe, expect, it } from 'vitest';
import { resolveCloudCredentials } from './cloud-credentials.js';

describe('resolving cloud credentials from the operator\'s settings', () => {
  it('uses the operator\'s keys only for a principal allowed to', () => {
    const operator = { OVH_APPLICATION_KEY: 'operator-key', OVH_APPLICATION_SECRET: 's', OVH_CONSUMER_KEY: 'c', OVH_SUBSIDIARY: 'FR' };
    expect(resolveCloudCredentials('ovh', undefined, operator).env.OVH_APPLICATION_KEY).toBe('operator-key');
    expect(resolveCloudCredentials('ovh', undefined, undefined).env.OVH_APPLICATION_KEY).toBeUndefined();
  });

  it('prefers the keys a person stored over the operator\'s', () => {
    expect(resolveCloudCredentials('ovh', { ovh: { applicationKey: 'mine', applicationSecret: 's', consumerKey: 'c', subsidiary: 'FR' } }, { OVH_APPLICATION_KEY: 'operator-key', OVH_APPLICATION_SECRET: 's', OVH_CONSUMER_KEY: 'c', OVH_SUBSIDIARY: 'FR' }).env.OVH_APPLICATION_KEY).toBe('mine');
  });

  it('says there are none when neither the person nor the operator has keys', () => {
    expect(resolveCloudCredentials('ovh', undefined, {})).toEqual({ mode: 'none', env: {} });
  });

  it('takes the operator\'s OVHcloud keys only with the subsidiary they belong to', () => {
    const keys = { OVH_APPLICATION_KEY: 'k', OVH_APPLICATION_SECRET: 's', OVH_CONSUMER_KEY: 'c' };
    expect(resolveCloudCredentials('ovh', undefined, keys)).toEqual({ mode: 'none', env: {} });
    expect(resolveCloudCredentials('ovh', undefined, { ...keys, OVH_SUBSIDIARY: 'AU' }).env.OVH_SUBSIDIARY).toBe('AU');
  });
});
