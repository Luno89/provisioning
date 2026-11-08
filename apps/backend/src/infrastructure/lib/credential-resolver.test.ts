import { describe, expect, it } from 'vitest';
import { credentialsFor } from './credential-resolver.js';

describe('the operator\'s own credentials', () => {
  it('are used only for the operator, never for another person on the same platform', () => {
    const operatorEnv = { GITHUB_TOKEN: 'operators-token' };
    expect(credentialsFor('github', undefined, operatorEnv)).toEqual({ mode: 'env', env: { GITHUB_TOKEN: 'operators-token', GH_TOKEN: 'operators-token' } });
    expect(credentialsFor('github', undefined, undefined)).toEqual({ mode: 'none', env: {} });
    expect(credentialsFor('github', { github: { token: 'theirs' } }, undefined)).toEqual({ mode: 'user', env: { GITHUB_TOKEN: 'theirs', GH_TOKEN: 'theirs' } });
  });
});
