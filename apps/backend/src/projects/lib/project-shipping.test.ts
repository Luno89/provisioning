import { describe, it, expect } from 'vitest';
import { webhookUrlAt, webhookUrlFor, shippingGaps, isShippable, deploysItself, DEFAULT_TARGET_CLUSTER, koalasClusterFor, sameHookPath } from './project-shipping.js';

describe('where Gitea posts a push', () => {
  it('uses the node address, not localhost', () => {
    expect(webhookUrlFor('10.0.0.155', 3001, 'p1')).toBe('http://10.0.0.155:3001/webhooks/gitea/p1');
  });

  it('takes the first address on a dual-stack node', () => {
    expect(webhookUrlFor('10.0.0.155 fe80::1', 3001, 'p1')).toBe('http://10.0.0.155:3001/webhooks/gitea/p1');
  });

  it('uses where Gitea reaches the backend when that is given', () => {
    expect(webhookUrlAt('http://127.0.0.1:4001/', 'p1')).toBe('http://127.0.0.1:4001/webhooks/gitea/p1');
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

describe('which webhook a new address replaces', () => {
  it('is the one for the same path, at any address', () => {
    expect(sameHookPath('http://10.0.0.130:3001/webhooks/gitea/p1', 'http://instance.nowrinkles.svc.cluster.local/webhooks/gitea/p1')).toBe(true);
    expect(sameHookPath('http://10.0.0.130:3001/webhooks/gitea/p1', 'http://10.0.0.130:3001/webhooks/gitea/p1')).toBe(true);
  });

  it('is never another project\'s, nor a hook with no address', () => {
    expect(sameHookPath('http://10.0.0.130:3001/webhooks/gitea/p2', 'http://instance.nowrinkles.svc.cluster.local/webhooks/gitea/p1')).toBe(false);
    expect(sameHookPath(undefined, 'http://x/webhooks/gitea/p1')).toBe(false);
    expect(sameHookPath('not a url', 'http://x/webhooks/gitea/p1')).toBe(false);
  });
});

describe('the cluster a project deploys to when none is picked', () => {
  it('is the cluster of the machine Koala runs on, on an instance', () => {
    expect(koalasClusterFor({ INSTANCE_MACHINE_ID: 'bbdd-1' })).toBe('machine-bbdd-1');
  });

  it('is the system cluster where Koala runs on no machine', () => {
    expect(koalasClusterFor({})).toBe(DEFAULT_TARGET_CLUSTER);
    expect(koalasClusterFor({ INSTANCE_MACHINE_ID: '  ' })).toBe(DEFAULT_TARGET_CLUSTER);
  });
});
