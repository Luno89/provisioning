import { describe, expect, it } from 'vitest';
import { stateSecretName, stateSecretSuffix } from './state-secret.js';

describe('the Secret Terraform keeps a stack\'s state in on a cluster', () => {
  it('is named as packages/cdktf-infra names it: the stack\'s own name with -state, or a hash of it where that would not fit a label', () => {
    expect(stateSecretSuffix('app-machine-desk-40213377')).toBe('app-machine-desk-40213377-state');
    expect(stateSecretSuffix('App_Desk.1')).toBe('app-desk-1-2e183d88-state');
    expect(stateSecretSuffix(`app-pool-${'b'.repeat(40)}-40213377`)).toBe(`app-pool-${'b'.repeat(39)}-3e401760-state`);
    expect(stateSecretName('app-machine-desk-40213377')).toBe('tfstate-default-app-machine-desk-40213377-state');
  });
});
