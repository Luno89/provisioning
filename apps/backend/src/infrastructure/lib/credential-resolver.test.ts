import { describe, expect, it } from 'vitest';
import { credentialsFor } from './credential-resolver.js';

describe('the operator\'s own credentials', () => {
  it('are used only for the operator, never for another person on the same platform', () => {
    const operatorEnv = { HCLOUD_TOKEN: 'operators-token' };
    expect(credentialsFor('hetzner', undefined, operatorEnv)).toEqual({ mode: 'env', env: { HCLOUD_TOKEN: 'operators-token' } });
    expect(credentialsFor('hetzner', undefined, undefined)).toEqual({ mode: 'mock', env: {} });
    expect(credentialsFor('hetzner', { hetzner: { token: 'theirs' } }, undefined)).toEqual({ mode: 'user', env: { HCLOUD_TOKEN: 'theirs' } });
  });
});
