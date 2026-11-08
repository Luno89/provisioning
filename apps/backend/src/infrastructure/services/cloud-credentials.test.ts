import { afterEach, describe, expect, it } from 'vitest';
import { resolveCloudCredentials } from './cloud-credentials.js';

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe('resolving cloud credentials from the environment', () => {
  it('uses the operator\'s environment keys only for a principal allowed to', () => {
    process.env.GITHUB_TOKEN = 'operator-token';
    expect(resolveCloudCredentials('github', undefined, true).env.GITHUB_TOKEN).toBe('operator-token');
    expect(resolveCloudCredentials('github', undefined, false).env.GITHUB_TOKEN).toBeUndefined();
  });

  it('prefers the keys a person stored over the environment', () => {
    process.env.GITHUB_TOKEN = 'operator-token';
    expect(resolveCloudCredentials('github', { github: { token: 'mine' } }).env.GITHUB_TOKEN).toBe('mine');
  });

  it('says there are none when neither the person nor the operator has keys', () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    expect(resolveCloudCredentials('github', undefined)).toEqual({ mode: 'none', env: {} });
  });
});
