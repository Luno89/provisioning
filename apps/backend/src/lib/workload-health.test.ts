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
    const list = { items: [{ metadata: { name: 'job' }, status: { phase: 'Succeeded' } }, ...pods([ok]).items] };
    expect(assessWorkload(list).health).toBe('healthy');
  });
});

describe('a workload that is still coming up', () => {
  it('calls an unready container starting, not failed', () => {
    expect(assessWorkload(pods([{ ready: false, restartCount: 0, state: { waiting: { reason: 'ContainerCreating' } } }])).health)
      .toBe('starting');
  });

  it('treats an empty namespace as starting rather than broken', () => {
    expect(assessWorkload({ items: [] }).health).toBe('starting');
  });

  it('tolerates a pod scheduled with no container status yet', () => {
    expect(assessWorkload({ items: [{ metadata: { name: 'p' }, status: { phase: 'Pending' } }] }).health).toBe('starting');
  });

  it('does not condemn a container that has restarted once', () => {
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
    expect(assessWorkload(pods([{ ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff' } } }])).health)
      .toBe('unhealthy');
  });

  it('catches repeated restarts before Kubernetes says CrashLoopBackOff', () => {
    const r = assessWorkload(pods([{ ready: false, restartCount: 3, state: {} }]));

    expect(r.health).toBe('unhealthy');
    expect(r.reason).toMatch(/restarted 3 times/);
  });

  it('says which pod, because a namespace can hold several', () => {
    const r = assessWorkload(pods([ok], [{ ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff' } } }]));
    expect(r.reason).toContain('pod-1');
  });
});

describe('a namespace with nothing long-running in it', () => {
  it('does not call a finished Job a healthy workload', () => {
    const r = assessWorkload({ items: [{ metadata: { name: 'migrate' }, status: { phase: 'Succeeded' } }] });
    expect(r.health).toBe('starting');
  });

  it('still judges a real pod sitting alongside a finished Job', () => {
    const r = assessWorkload({ items: [
      { metadata: { name: 'migrate' }, status: { phase: 'Succeeded' } },
      { metadata: { name: 'web' }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] } },
    ] });
    expect(r.health).toBe('healthy');
  });
});

describe('what the record should say', () => {
  it('marks a settled failure unhealthy, not failed', () => {
    expect(reconciledStatus('running', 'unhealthy')).toBe('unhealthy');
  });

  it('lets a recovered workload go back to running', () => {
    expect(reconciledStatus('unhealthy', 'healthy')).toBe('running');
  });

  it('changes nothing while a workload is starting or unreadable', () => {
    expect(reconciledStatus('running', 'starting')).toBeUndefined();
    expect(reconciledStatus('running', 'unknown')).toBeUndefined();
  });

  it('never touches a deployment mid-flight', () => {
    expect(reconciledStatus('deploying', 'unhealthy')).toBeUndefined();
    expect(reconciledStatus('destroying', 'unhealthy')).toBeUndefined();
  });

  it('leaves a failed deploy failed, however the namespace looks', () => {
    expect(reconciledStatus('failed', 'healthy')).toBeUndefined();
    expect(reconciledStatus('failed', 'unhealthy')).toBeUndefined();
  });

  it('does not rewrite a status that already agrees', () => {
    expect(reconciledStatus('running', 'healthy')).toBeUndefined();
    expect(reconciledStatus('unhealthy', 'unhealthy')).toBeUndefined();
  });
});
