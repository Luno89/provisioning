import { describe, expect, it } from 'vitest';
import { retargetedStateSecrets } from './state-retarget.js';

describe('the Terraform state a move brings onto the machine', () => {
  const secret = (suffix: string, data = 'c2hlbGY=') => ({
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque', data: { tfstate: data },
    metadata: { name: `tfstate-default-${suffix}`, labels: { tfstate: 'true', tfstateSecretSuffix: suffix, tfstateWorkspace: 'default', 'app.kubernetes.io/managed-by': 'terraform' } },
  });
  const long = `pool-${'b'.repeat(40)}`;

  it('names the state of each app on the pool\'s cluster for the machine\'s cluster, since an app\'s stack is named after its cluster, and leaves every other stack\'s state as it came', () => {
    const carried = [
      secret('app-pool-shop-40213377-state', 'c2hvcA=='),
      secret('platform-gitea-state'),
      secret('app-machine-lab-11111111-state'),
      secret('app-pool-shop-99999999-state'),
    ];
    expect(retargetedStateSecrets(carried, { from: 'pool-shop', onto: 'machine-desk', deploymentIds: ['40213377', '55555555'] })).toEqual([
      secret('app-machine-desk-40213377-state', 'c2hvcA=='),
      secret('platform-gitea-state'),
      secret('app-machine-lab-11111111-state'),
      secret('app-pool-shop-99999999-state'),
    ]);
  });

  it('leaves out the state of the pool\'s monitoring, which the machine\'s cluster never uses, and keeps another cluster\'s', () => {
    const carried = [secret('pool-shop-state'), secret('pool-shop-observability-state'), secret('platform-gitea-state'), secret('pool-other-observability-state')];
    expect(retargetedStateSecrets(carried, { from: 'pool-shop', onto: 'machine-desk', deploymentIds: [] })).toEqual([secret('platform-gitea-state'), secret('pool-other-observability-state')]);
  });

  it('finds an app\'s state by the name Terraform gave it, hashed where the stack\'s name is too long for a label', () => {
    const carried = [secret(`app-pool-${'b'.repeat(39)}-3e401760-state`)];
    expect(retargetedStateSecrets(carried, { from: long, onto: 'machine-desk', deploymentIds: ['40213377'] })).toEqual([secret('app-machine-desk-40213377-state')]);
  });
});
