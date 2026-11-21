import { describe, it, expect } from 'vitest';
import { assessWorkload } from '@koala/provision';
import { LIVE_ACTIVITY } from './activity-liveness.js';

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

describe('how long an activity may take', () => {
  it('is bounded by nothing but the largest start-to-close Temporal accepts, while a heartbeat says the worker is alive', () => {
    expect(LIVE_ACTIVITY).toEqual({ startToCloseTimeout: 315_576_000_000_000, heartbeatTimeout: '1 minute', cancellationType: 'WAIT_CANCELLATION_COMPLETED' });
  });
});
