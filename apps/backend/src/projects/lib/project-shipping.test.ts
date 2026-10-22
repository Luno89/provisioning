import { describe, it, expect } from 'vitest';
import { webhookUrlFor, shippingGaps, isShippable, deploysItself, DEFAULT_TARGET_CLUSTER } from './project-shipping.js';

describe('where Gitea posts a push', () => {
  it('uses the node address, not localhost', () => {
    expect(webhookUrlFor('10.0.0.155', 3001, 'p1')).toBe('http://10.0.0.155:3001/webhooks/gitea/p1');
  });

  it('takes the first address on a dual-stack node', () => {
    expect(webhookUrlFor('10.0.0.155 fe80::1', 3001, 'p1')).toBe('http://10.0.0.155:3001/webhooks/gitea/p1');
  });
});

describe('whether a project can actually ship', () => {
  it('names each missing piece rather than answering yes or no', () => {
    expect(shippingGaps({})).toEqual([
      'no webhook, so pushes will not build it',
      'no target cluster, so a built image has nowhere to go',
    ]);
  });

  it('is satisfied once both are set', () => {
    const wired = { webhookSecretEnc: 'enc', targetClusterId: DEFAULT_TARGET_CLUSTER };
    expect(shippingGaps(wired)).toEqual([]);
    expect(isShippable(wired)).toBe(true);
  });

  it('is not satisfied by a webhook alone', () => {
    expect(isShippable({ webhookSecretEnc: 'enc' })).toBe(false);
  });
});

describe('whether a push runs all the way to a deployment', () => {
  it('needs auto-deploy on top of being shippable', () => {
    const wired = { webhookSecretEnc: 'enc', targetClusterId: 'c1' };
    expect(isShippable(wired)).toBe(true);
    expect(deploysItself(wired)).toBe(false);
    expect(deploysItself({ ...wired, autoDeployOnBuild: true })).toBe(true);
  });

  it('is not self-deploying just because the flag is set', () => {
    expect(deploysItself({ autoDeployOnBuild: true })).toBe(false);
  });
});
