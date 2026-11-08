import { describe, expect, it, vi } from 'vitest';
import { handedOver } from './handed-over.js';

describe('the reach a workflow hands its cluster steps', () => {
  it('starts a machine first and hands on the kubeconfig the machine answered with', async () => {
    const start = vi.fn(async () => 'apiVersion: v1');
    const handed = await handedOver({ clusterId: 'machine-desk', machine: { deviceId: 'desk' }, name: 'shop' }, start);
    expect(start).toHaveBeenCalledWith({ deviceId: 'desk' }, 'machine-desk');
    expect(handed).toEqual({ clusterId: 'machine-desk', machine: { deviceId: 'desk' }, name: 'shop', reach: { clusterId: 'machine-desk', kind: 'machine', kubeconfig: 'apiVersion: v1' } });
  });

  it('hands on the reach its starter worked out, starting nothing', async () => {
    const start = vi.fn(async () => 'never');
    const reach = { clusterId: 'machine-dev1', kind: 'koala' } as const;
    expect(await handedOver({ clusterId: 'machine-dev1', reach }, start)).toEqual({ clusterId: 'machine-dev1', reach });
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses work started with neither, such as work a release before this one started', async () => {
    await expect(handedOver({ clusterId: 'machine-desk' }, vi.fn())).rejects.toThrow('this work was started with no way to reach machine-desk');
  });
});
