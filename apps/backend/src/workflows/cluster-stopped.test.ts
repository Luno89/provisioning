import { describe, expect, it, vi } from 'vitest';
import { MACHINE_CLUSTER_KEPT, type MachineClusterResult } from '@koala/engine-core';
import { stoppedWhenIdle } from './cluster-stopped.js';

const steps = (idle: boolean, answer: MachineClusterResult) => ({
  idle: vi.fn(async () => idle),
  stop: vi.fn(async () => answer),
  stopped: vi.fn(async () => undefined),
});

describe('stopping a machine\'s cluster once nothing runs on it', () => {
  it('records it stopped once the machine says it stopped, or that it has no cluster', async () => {
    for (const answer of [{ state: 'stopped' }, { state: 'absent' }] as const) {
      const asked = steps(true, answer);
      expect(await stoppedWhenIdle(asked)).toBe(true);
      expect(asked.stopped).toHaveBeenCalledOnce();
    }
  });

  it('leaves the record running when the machine kept its cluster for the Koala it holds', async () => {
    const asked = steps(true, { state: 'kept', why: MACHINE_CLUSTER_KEPT });
    expect(await stoppedWhenIdle(asked)).toBe(false);
    expect(asked.stop).toHaveBeenCalledOnce();
    expect(asked.stopped).not.toHaveBeenCalled();
  });

  it('asks the machine nothing while apps still run on it', async () => {
    const asked = steps(false, { state: 'stopped' });
    expect(await stoppedWhenIdle(asked)).toBe(false);
    expect(asked.stop).not.toHaveBeenCalled();
    expect(asked.stopped).not.toHaveBeenCalled();
  });

  it('fails for good when the machine answers a stop as running, recording nothing', async () => {
    const asked = steps(true, { state: 'running', kubeconfig: 'apiVersion: v1', meshIp: '100.64.0.9' });
    await expect(stoppedWhenIdle(asked)).rejects.toThrow('the machine answered running when its cluster was stopped');
    expect(asked.stopped).not.toHaveBeenCalled();
  });
});
