import { describe, expect, it } from 'vitest';
import type { DeploymentMetadata } from '../../platform/index.js';
import { followedAction } from './followed-work.js';

const app = (extra: Partial<DeploymentMetadata>): DeploymentMetadata => ({ id: 'shop', name: 'shop', clusterId: 'c1', strategy: 'helm', status: 'deploying', temporalWorkflowId: 'wf-2', ...extra });

describe('what a followed app is doing, read from its record alone', () => {
  it('follows a deploy whose record says it resizes or syncs its settings as that, so another process settles it the same way', () => {
    expect(followedAction({ kind: 'deployment', record: app({ followedFor: { workflowId: 'wf-2', action: 'app-resize', newStorage: { data: '20Gi' } } }) })).toBe('app-resize');
    expect(followedAction({ kind: 'deployment', record: app({ followedFor: { workflowId: 'wf-2', action: 'app-sync-config' } }) })).toBe('app-sync-config');
  });

  it('takes a marker left from an earlier workflow as nothing, so a plain deploy after a resize is followed as a deploy', () => {
    expect(followedAction({ kind: 'deployment', record: app({ followedFor: { workflowId: 'wf-1', action: 'app-resize', newStorage: { data: '20Gi' } } }) })).toBe('app-deploy');
    expect(followedAction({ kind: 'deployment', record: app({}) })).toBe('app-deploy');
    expect(followedAction({ kind: 'deployment', record: app({ status: 'destroying' }) })).toBe('app-destroy');
  });
});
