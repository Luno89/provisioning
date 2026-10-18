import { describe, it, expect } from 'vitest';
import { createMachineWorkspaces } from './machine-workspaces.js';
import type { RunTicket } from '../temporal/contracts.js';

const ticket = (modelId: string | undefined, ownerId = 'bo'): RunTicket => ({ runId: 'r1', depth: 0, ownerId, agentSlug: 'koala', trigger: 'user', ...(modelId ? { modelId } : {}) });
const machines = createMachineWorkspaces({ list: async () => [{ id: 'd1', ownerId: 'bo', name: 'desk' }] });

describe('the machine a run was given', () => {
  it('is the person\'s own machine named by the pick', async () => {
    expect(await machines.forRun(ticket('machine:d1:antigravity'))).toEqual({ kind: 'machine', deviceId: 'd1', deviceName: 'desk' });
  });

  it('is nothing for a model, for a machine that is gone, or for someone else\'s machine', async () => {
    expect(await machines.forRun(ticket('tabby-qwen'))).toBeUndefined();
    expect(await machines.forRun(ticket('machine:d9:antigravity'))).toBeUndefined();
    expect(await machines.forRun(ticket('machine:d1:antigravity', 'al'))).toBeUndefined();
  });

  it('is nothing for an agent that keeps its own procedure on the machine, which works in the environment it would have on a model', async () => {
    expect(await machines.forRun({ ...ticket('machine:d1:antigravity'), inPlace: true })).toBeUndefined();
  });
});
