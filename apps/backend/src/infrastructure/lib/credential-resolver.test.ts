import { describe, expect, it } from 'vitest';
import { resolveCloudCredentials } from './credential-resolver.js';

describe('the operator\'s own credentials', () => {
  it('are used only for the operator, never for another person on the same platform', () => {
    const before = process.env.HCLOUD_TOKEN;
    process.env.HCLOUD_TOKEN = 'operators-token';
    try {
      expect(resolveCloudCredentials('hetzner', undefined)).toEqual({ mode: 'env', env: { HCLOUD_TOKEN: 'operators-token' } });
      expect(resolveCloudCredentials('hetzner', undefined, false)).toEqual({ mode: 'mock', env: {} });
      expect(resolveCloudCredentials('hetzner', { hetzner: { token: 'theirs' } } as never, false)).toEqual({ mode: 'user', env: { HCLOUD_TOKEN: 'theirs' } });
    } finally {
      if (before === undefined) delete process.env.HCLOUD_TOKEN; else process.env.HCLOUD_TOKEN = before;
    }
  });
});
