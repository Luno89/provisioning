import { describe, it, expect } from 'vitest';
import { assessWorkload } from './workload-health.js';
import { checkWorkloadActivityMeta, deployAppActivityMeta } from './activity-timeouts.js';

const podsWith = (c: object) => ({ items: [{ metadata: { name: 'p' }, status: { phase: 'Running', containerStatuses: [c] } }] });

describe('what ends the wait', () => {
  it('ends on a healthy workload', () => {
    expect(assessWorkload(podsWith({ ready: true, restartCount: 0, state: {} })).health).toBe('healthy');
  });

  it('ends on a settled failure', () => {
    expect(assessWorkload(podsWith({ ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff' } } })).health)
      .toBe('unhealthy');
  });

  it('keeps waiting while a pod is merely slow', () => {
    expect(assessWorkload(podsWith({ ready: false, restartCount: 0, state: { waiting: { reason: 'ContainerCreating' } } })).health)
      .toBe('starting');
  });

  it('keeps waiting when the cluster cannot be read', () => {
    expect(assessWorkload(undefined).health).toBe('unknown');
  });
});

describe('the wait is not shorter than the deploy', () => {
  it('checks briefly and often, rather than holding one long activity open', () => {
    expect(checkWorkloadActivityMeta.startToCloseTimeout).toBe('2 minutes');
  });

  it('gives the rollout a window comparable to the deploy itself', () => {
    expect(deployAppActivityMeta.startToCloseTimeout).toBe('80 minutes');
  });
});
