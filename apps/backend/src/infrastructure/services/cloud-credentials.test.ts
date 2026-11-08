import { describe, expect, it } from 'vitest';
import { resolveCloudCredentials } from './cloud-credentials.js';

describe('resolving cloud credentials from the operator\'s settings', () => {
  it('uses the operator\'s keys only for a principal allowed to', () => {
    const operator = { GITHUB_TOKEN: 'operator-token' };
    expect(resolveCloudCredentials('github', undefined, operator).env.GITHUB_TOKEN).toBe('operator-token');
    expect(resolveCloudCredentials('github', undefined, undefined).env.GITHUB_TOKEN).toBeUndefined();
  });

  it('prefers the keys a person stored over the operator\'s', () => {
    expect(resolveCloudCredentials('github', { github: { token: 'mine' } }, { GITHUB_TOKEN: 'operator-token' }).env.GITHUB_TOKEN).toBe('mine');
  });

  it('says there are none when neither the person nor the operator has keys', () => {
    expect(resolveCloudCredentials('github', undefined, {})).toEqual({ mode: 'none', env: {} });
  });

  it('takes the operator\'s OVHcloud keys only with the subsidiary they belong to', () => {
    const keys = { OVH_APPLICATION_KEY: 'k', OVH_APPLICATION_SECRET: 's', OVH_CONSUMER_KEY: 'c' };
    expect(resolveCloudCredentials('ovh', undefined, keys)).toEqual({ mode: 'none', env: {} });
    expect(resolveCloudCredentials('ovh', undefined, { ...keys, OVH_SUBSIDIARY: 'AU' }).env.OVH_SUBSIDIARY).toBe('AU');
  });
});
