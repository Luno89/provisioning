import { describe, it, expect, vi } from 'vitest';
import { createHostOpNodes } from './host-op-nodes.js';
import type { HostNodeServices } from './services.js';

const request = (operation: string, ownerId = 'user-1') => ({
  node: { id: 'op', kind: 'host-op', settings: { operation }, position: { x: 0, y: 0 } },
  origin: 'op',
  inputs: {},
  execution: 1,
  run: { identity: { runId: 'r', depth: 0, agentId: 'grove', loopId: 'grove-run', loopVersion: '1', trigger: 'user' }, launch: { ownerId }, handles: new Set(), inputs: {}, counters: {}, budget: {}, cleaningUp: false, emit: () => undefined },
} as never);

describe('running a platform operation', () => {
  const open = vi.fn(async () => ({ exit: 'ready', outputs: {} }));
  const services = {
    operations: { 'grove.open-tree': open },
    hidden: async (ownerId: string) => ({
      extensions: new Set(ownerId === 'user-1' ? ['grove'] : []),
      operations: new Set(ownerId === 'user-1' ? ['grove.open-tree'] : []),
      groups: new Set<string>(),
      tools: new Set<string>(),
      agents: new Set<string>(),
    }),
  } as unknown as HostNodeServices;
  const [node] = createHostOpNodes(services);
  const step = (node as unknown as { run: (request: never) => Promise<unknown> }).run;

  it('runs the operation for an owner who has its extension on', async () => {
    await expect(step(request('grove.open-tree', 'user-2'))).resolves.toMatchObject({ exit: 'ready' });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('refuses it, saying why, for an owner who switched its extension off', async () => {
    await expect(step(request('grove.open-tree', 'user-1'))).rejects.toThrow(/grove extension, which is switched off for you/);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('refuses an operation nothing on this worker implements', async () => {
    await expect(step(request('grove.nothing', 'user-2'))).rejects.toThrow(/not an operation this worker can run/);
  });
});
