import { describe, expect, it } from 'vitest';
import { credentialsFor } from './credential-resolver.js';

const OVH_ENV = { OVH_APPLICATION_KEY: 'k', OVH_APPLICATION_SECRET: 's', OVH_CONSUMER_KEY: 'c', OVH_SUBSIDIARY: 'AU' };

describe('the operator\'s own credentials', () => {
  it('are used only for the operator, never for another person on the same platform', () => {
    expect(credentialsFor('ovh', undefined, OVH_ENV)).toEqual({ mode: 'env', env: OVH_ENV });
    expect(credentialsFor('ovh', undefined, undefined)).toEqual({ mode: 'none', env: {} });
    expect(credentialsFor('ovh', { ovh: { applicationKey: 'a', applicationSecret: 'b', consumerKey: 'c', subsidiary: 'FR' } }, undefined))
      .toEqual({ mode: 'user', env: { OVH_APPLICATION_KEY: 'a', OVH_APPLICATION_SECRET: 'b', OVH_CONSUMER_KEY: 'c', OVH_SUBSIDIARY: 'FR' } });
  });
});

describe('a Hugging Face token', () => {
  it('is only ever the person\'s own, never one from the process\'s environment', () => {
    const env = { HF_TOKEN: 'operators', VLLM_HF_TOKEN: 'operators', HUGGING_FACE_HUB_TOKEN: 'operators' };
    expect(credentialsFor('huggingface', undefined, env)).toEqual({ mode: 'none', env: {} });
    expect(credentialsFor('huggingface', { huggingface: { hfToken: 'theirs' } }, env)).toEqual({ mode: 'user', env: { HF_TOKEN: 'theirs', HUGGING_FACE_HUB_TOKEN: 'theirs' } });
  });
});

describe('a GitHub token', () => {
  it('is no credential Koala keeps or takes from the environment', () => {
    expect(credentialsFor('github', { github: { token: 'theirs' } } as never, { GITHUB_TOKEN: 'operators', GH_TOKEN: 'operators' })).toEqual({ mode: 'none', env: {} });
  });
});
