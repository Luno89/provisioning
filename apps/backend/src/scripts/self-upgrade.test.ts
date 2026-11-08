import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterStarts } from '../instances/index.js';
import { selfUpgradeClusterOn } from './self-upgrade.js';

const own = { clusterId: 'machine-desk', kind: 'koala' } as const;

function cluster(ended: Promise<{ code: number; stdout: string; stderr: string }>) {
  const access = mock<ClusterStarts>();
  access.own.mockReturnValue(own);
  const stopped: string[] = [];
  access.startHelm.mockResolvedValue({ stop: () => { stopped.push('stopped'); }, ended });
  return { access, stopped };
}

describe('the self-upgrade reaching the cluster its instance runs in', () => {
  it('asks kubectl there', async () => {
    const { access } = cluster(Promise.resolve({ code: 0, stdout: '', stderr: '' }));
    access.kubectl.mockResolvedValue('{"items":[]}');
    expect(await selfUpgradeClusterOn(access).kubectl(['get', 'jobs'])).toBe('{"items":[]}');
    expect(access.kubectl).toHaveBeenCalledWith(own, ['get', 'jobs']);
  });

  it('runs helm there and hands back what it printed', async () => {
    const { access, stopped } = cluster(Promise.resolve({ code: 0, stdout: 'upgraded', stderr: '' }));
    expect(await selfUpgradeClusterOn(access).helm(['upgrade', 'luno'])).toBe('upgraded');
    expect(access.startHelm).toHaveBeenCalledWith(own, ['upgrade', 'luno']);
    expect(stopped).toEqual([]);
  });

  it('fails with how helm ended and what it said', async () => {
    const { access } = cluster(Promise.resolve({ code: 1, stdout: '', stderr: 'Error: UPGRADE FAILED\n' }));
    await expect(selfUpgradeClusterOn(access).helm(['rollback', 'luno'])).rejects.toThrow('helm rollback ended with 1: Error: UPGRADE FAILED');
  });

  it('stops helm the moment the upgrade stops waiting on it', async () => {
    let end: (result: { code: number; stdout: string; stderr: string }) => void = () => undefined;
    const { access, stopped } = cluster(new Promise((resolve) => { end = resolve; }));
    access.startHelm.mockImplementation(async () => ({ stop: () => { stopped.push('stopped'); end({ code: 137, stdout: '', stderr: '' }); }, ended: new Promise((resolve) => { end = resolve; }) }));
    const stop = new AbortController();
    const running = selfUpgradeClusterOn(access).helm(['upgrade', 'luno'], stop.signal);
    await Promise.resolve();
    await Promise.resolve();
    stop.abort();
    await expect(running).rejects.toThrow('helm upgrade ended with 137');
    expect(stopped).toEqual(['stopped']);
  });

  it('stops helm at once when the upgrade stopped waiting before it started', async () => {
    let end: (result: { code: number; stdout: string; stderr: string }) => void = () => undefined;
    const stopped: string[] = [];
    const access = mock<ClusterStarts>();
    access.own.mockReturnValue(own);
    access.startHelm.mockImplementation(async () => ({ stop: () => { stopped.push('stopped'); end({ code: 137, stdout: '', stderr: '' }); }, ended: new Promise((resolve) => { end = resolve; }) }));
    const stop = new AbortController();
    stop.abort();
    await expect(selfUpgradeClusterOn(access).helm(['upgrade', 'luno'], stop.signal)).rejects.toThrow('helm upgrade ended with 137');
    expect(stopped).toEqual(['stopped']);
  });
});
