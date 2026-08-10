/**
 * The deploy workflow applied and returned. "Did Terraform finish" is not "does the thing work" —
 * a real promote reported `running` for six minutes against a pod in CrashLoopBackOff.
 *
 * These pin the decisions the wait makes, since the wait itself lives in workflow timers and the
 * shape that matters is which verdict ends it.
 */
import { describe, it, expect } from 'vitest';
import { assessWorkload } from './workload-health.js';
import { checkWorkloadActivityMeta, deployAppActivityMeta } from './activity-timeouts.js';

const podsWith = (c: object) => ({ items: [{ metadata: { name: 'p' }, status: { phase: 'Running', containerStatuses: [c] } }] });

describe('what ends the wait', () => {
  it('ends on a healthy workload', () => {
    expect(assessWorkload(podsWith({ ready: true, restartCount: 0, state: {} })).health).toBe('healthy');
  });

  it('ends on a settled failure', () => {
    // Throwing is how a deploy is already reported failed, so this is what marks the deployment.
    expect(assessWorkload(podsWith({ ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff' } } })).health)
      .toBe('unhealthy');
  });

  it('keeps waiting while a pod is merely slow', () => {
    /**
     * The mistake worth not repeating: a hardcoded timeout once capped every deploy at thirty
     * minutes and killed a TabbyAPI rollout whose model download was still running. Slow is not
     * failed.
     */
    expect(assessWorkload(podsWith({ ready: false, restartCount: 0, state: { waiting: { reason: 'ContainerCreating' } } })).health)
      .toBe('starting');
  });

  it('keeps waiting when the cluster cannot be read', () => {
    // A transient kubectl error must not fail a deploy.
    expect(assessWorkload(undefined).health).toBe('unknown');
  });
});

describe('the wait is not shorter than the deploy', () => {
  it('checks briefly and often, rather than holding one long activity open', () => {
    // The waiting is durable workflow timers, so a worker restart mid-rollout resumes it. This
    // activity is one kubectl read.
    expect(checkWorkloadActivityMeta.startToCloseTimeout).toBe('2 minutes');
  });

  it('gives the rollout a window comparable to the deploy itself', () => {
    // 60 checks at 30s is 30 minutes of watching, against an 80-minute deploy ceiling — long
    // enough to catch a settled failure, and deliberately not a second clock on success.
    expect(deployAppActivityMeta.startToCloseTimeout).toBe('80 minutes');
  });
});
