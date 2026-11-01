import { describe, expect, it } from 'vitest';
import { deploymentConfigPatch } from './deployment-config.js';

describe('a deployment config change as it arrives', () => {
  it('keeps only the fields a person may change, as sent', () => {
    expect(deploymentConfigPatch({ tabbyGpuCount: 2, tabbyCacheMode: '', tabbyReasoning: true, storage: { web: '10Gi' }, ownerId: 'someone-else', namespace: 'kube-system' }))
      .toEqual({ patch: { tabbyGpuCount: 2, tabbyCacheMode: '', tabbyReasoning: true, storage: { web: '10Gi' } } });
  });

  it('refuses a field of the wrong kind by name rather than storing it', () => {
    expect(deploymentConfigPatch({ vllmMaxModelLen: null })).toEqual({ problem: 'vllmMaxModelLen must be a number' });
    expect(deploymentConfigPatch({ tabbyReasoning: 'yes' })).toEqual({ problem: 'tabbyReasoning must be true or false' });
    expect(deploymentConfigPatch({ storage: { web: 10 } })).toEqual({ problem: 'storage must be an object of text values' });
  });

  it('hands the app settings over apart, for the app\'s schema to check', () => {
    expect(deploymentConfigPatch({ appSettings: { MAX_PLAYERS: 8 } })).toEqual({ patch: {}, appSettings: { MAX_PLAYERS: 8 } });
    expect(deploymentConfigPatch({ appSettings: 'all of them' })).toEqual({ problem: 'appSettings must be an object' });
  });
});
