import { afterEach, describe, expect, it } from 'vitest';
import { hasCloudCredentials, isMockCloudProvider, resolveCloudCredentials } from './cloud-credentials.js';

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe('resolving cloud credentials from the environment', () => {
  it('uses the operator\'s environment keys only for a principal allowed to', () => {
    process.env.HCLOUD_TOKEN = 'operator-token';
    expect(resolveCloudCredentials('hetzner', undefined, true).env.HCLOUD_TOKEN).toBe('operator-token');
    expect(resolveCloudCredentials('hetzner', undefined, false).env.HCLOUD_TOKEN).toBeUndefined();
  });

  it('prefers the keys a person stored over the environment', () => {
    process.env.HCLOUD_TOKEN = 'operator-token';
    expect(resolveCloudCredentials('hetzner', { hetzner: { token: 'mine' } }).env.HCLOUD_TOKEN).toBe('mine');
  });

  it('knows whether a provider has keys anywhere', () => {
    delete process.env.HCLOUD_TOKEN;
    expect(hasCloudCredentials('hetzner')).toBe(false);
    process.env.HCLOUD_TOKEN = 'operator-token';
    expect(hasCloudCredentials('hetzner')).toBe(true);
    delete process.env.HCLOUD_TOKEN;
    expect(hasCloudCredentials('hetzner', { hetzner: { token: 'mine' } })).toBe(true);
  });

  it('runs a provider as local containers only on a dev box with no keys', () => {
    process.env.NODE_ENV = 'development';
    expect(isMockCloudProvider('aws', () => false)).toBe(true);
    expect(isMockCloudProvider('aws', () => true)).toBe(false);
    process.env.NODE_ENV = 'production';
    expect(isMockCloudProvider('aws', () => false)).toBe(false);
  });
});
