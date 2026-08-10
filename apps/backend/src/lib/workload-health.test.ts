/**
 * A deployment was marked `running` when the CDKTF apply succeeded and nothing ever looked at the
 * pod again. Observed on the first promote-to-staging: `running` for six minutes while the pod sat
 * in CrashLoopBackOff with four restarts.
 *
 * The cases that matter most here are the ones that must NOT fire — a check that flags every deploy
 * during its first seconds is worse than the silence it replaces.
 */
import { describe, it, expect } from 'vitest';
import { assessWorkload, reconciledStatus } from './workload-health.js';

const pods = (...containers: object[][]) => ({
  items: containers.map((cs, i) => ({
    metadata: { name: `pod-${i}` },
    status: { phase: 'Running', containerStatuses: cs },
  })),
});

const ok = { ready: true, restartCount: 0, state: {} };

describe('a workload that is fine', () => {
  it('is healthy when every container is ready', () => {
    expect(assessWorkload(pods([ok], [ok])).health).toBe('healthy');
  });

  it('ignores a completed job pod', () => {
    // A finished Job says nothing about a Deployment's health.
    const list = { items: [{ metadata: { name: 'job' }, status: { phase: 'Succeeded' } }, ...pods([ok]).items] };
    expect(assessWorkload(list).health).toBe('healthy');
  });
});

describe('a workload that is still coming up', () => {
  it('calls an unready container starting, not failed', () => {
    // Containers boot. Flagging this would cry wolf on every deploy.
    expect(assessWorkload(pods([{ ready: false, restartCount: 0, state: { waiting: { reason: 'ContainerCreating' } } }])).health)
      .toBe('starting');
  });

  it('treats an empty namespace as starting rather than broken', () => {
    // A namespace mid-apply has no pods yet.
    expect(assessWorkload({ items: [] }).health).toBe('starting');
  });

  it('tolerates a pod scheduled with no container status yet', () => {
    expect(assessWorkload({ items: [{ metadata: { name: 'p' }, status: { phase: 'Pending' } }] }).health).toBe('starting');
  });

  it('does not condemn a container that has restarted once', () => {
    // One restart is a hiccup. Settled failure is the bar.
    expect(assessWorkload(pods([{ ready: false, restartCount: 1, state: {} }])).health).toBe('starting');
  });
});

describe('a workload that has settled into failing', () => {
  it('catches CrashLoopBackOff, which is the case that was invisible', () => {
    const r = assessWorkload(pods([{ ready: false, restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } } }]));

    expect(r.health).toBe('unhealthy');
    expect(r.reason).toContain('CrashLoopBackOff');
  });

  it('catches an image that cannot be pulled', () => {
    // A configuration error no amount of waiting resolves — a wrong tag, or a registry it cannot
    // reach.
    expect(assessWorkload(pods([{ ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff' } } }])).health)
      .toBe('unhealthy');
  });

  it('catches repeated restarts before Kubernetes says CrashLoopBackOff', () => {
    // A container that exits immediately churns through restarts first, looking merely "not ready".
    const r = assessWorkload(pods([{ ready: false, restartCount: 3, state: {} }]));

    expect(r.health).toBe('unhealthy');
    expect(r.reason).toMatch(/restarted 3 times/);
  });

  it('says which pod, because a namespace can hold several', () => {
    const r = assessWorkload(pods([ok], [{ ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff' } } }]));
    expect(r.reason).toContain('pod-1');
  });
});

describe('what the record should say', () => {
  it('marks a settled failure unhealthy, not failed', () => {
    // `failed` means the deploy did not complete. This deploy completed; the container is broken.
    expect(reconciledStatus('running', 'unhealthy')).toBe('unhealthy');
  });

  it('lets a recovered workload go back to running', () => {
    // A status that only ever gets worse is one people learn to ignore.
    expect(reconciledStatus('unhealthy', 'healthy')).toBe('running');
  });

  it('changes nothing while a workload is starting or unreadable', () => {
    expect(reconciledStatus('running', 'starting')).toBeUndefined();
    expect(reconciledStatus('running', 'unknown')).toBeUndefined();
  });

  it('never touches a deployment mid-flight', () => {
    // `deploying` and `destroying` belong to the workflow doing the work; relabelling one from
    // outside would race it.
    expect(reconciledStatus('deploying', 'unhealthy')).toBeUndefined();
    expect(reconciledStatus('destroying', 'unhealthy')).toBeUndefined();
  });

  it('leaves a failed deploy failed, however the namespace looks', () => {
    /**
     * A deploy that never completed is a fact about history. Flipping it to `running` because
     * something in the namespace looks healthy — a leftover pod from the previous release, say —
     * would erase the record of the failure. Only a new deploy clears it.
     */
    expect(reconciledStatus('failed', 'healthy')).toBeUndefined();
    expect(reconciledStatus('failed', 'unhealthy')).toBeUndefined();
  });

  it('does not rewrite a status that already agrees', () => {
    expect(reconciledStatus('running', 'healthy')).toBeUndefined();
    expect(reconciledStatus('unhealthy', 'unhealthy')).toBeUndefined();
  });
});
