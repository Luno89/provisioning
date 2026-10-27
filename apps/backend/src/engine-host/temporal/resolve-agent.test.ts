import { describe, expect, it } from 'vitest';
import { createEngineActivities } from './activities.js';
import { createAgentRegistry } from '../registries/registry.js';
import { machineChoiceProblem, type MachineAgent } from '../../machines/lib/machines.js';
import type { MachineChoice } from '@koala/agent-engine/procedure';

const ANTIGRAVITY: MachineAgent = { id: 'antigravity', title: 'Antigravity', state: 'ready', source: 'found' };
const DEVICES = [{ id: 'd1', ownerId: 'user-1', name: 'laptop', agents: [ANTIGRAVITY] }, { id: 'd2', ownerId: 'user-2', name: 'their desk', agents: [ANTIGRAVITY] }];
const machineProblem = async (ownerId: string, choice: MachineChoice) => {
  const device = DEVICES.find((one) => one.id === choice.deviceId && one.ownerId === ownerId);
  return machineChoiceProblem(device ? { name: device.name, online: false, agents: device.agents } : undefined, choice.agent, { waitsToConnect: true });
};

const resolveAgent = () => createEngineActivities({ registry: createAgentRegistry(), machineProblem } as never).EngineResolveAgentActivity;

describe('an agent a machine is handed down to', () => {
  it('works on the machine in its own procedure when the procedure branches at Where It Runs', async () => {
    const resolved = await resolveAgent()({ ownerId: 'user-1', agentSlug: 'research', modelId: 'machine:d1:antigravity', handedDown: true });

    expect(resolved).toMatchObject({ found: true, machine: 'machine:d1:antigravity', inPlace: true });
    expect(resolved.procedure?.id).toBe('research');
  });

  it('keeps its own model and procedure when its procedure cannot work on a machine', async () => {
    const resolved = await resolveAgent()({ ownerId: 'user-1', agentSlug: 'delivery', modelId: 'machine:d1:antigravity', handedDown: true });

    expect(resolved).toMatchObject({ found: true });
    expect(resolved).not.toHaveProperty('machine');
    expect(resolved.procedure?.id).toBe('delivery');
  });

  it('still puts an agent picked for a machine itself there, whatever its procedure', async () => {
    const resolved = await resolveAgent()({ ownerId: 'user-1', agentSlug: 'delivery', modelId: 'machine:d1:antigravity' });

    expect(resolved).toMatchObject({ machine: 'machine:d1:antigravity' });
    expect(resolved.procedure?.id).toBe('external-agent-task');
  });
});

describe('a machine a run under another run is sent to', () => {
  it('is refused when it is someone else\'s, however the run came to name it', async () => {
    await expect(resolveAgent()({ ownerId: 'user-1', agentSlug: 'delivery', modelId: 'machine:d2:antigravity' }))
      .rejects.toThrow(/cannot go to that machine: that machine is not one of yours/);
    await expect(resolveAgent()({ ownerId: 'user-1', agentSlug: 'research', modelId: 'machine:d2:antigravity', handedDown: true }))
      .rejects.toThrow(/not one of yours/);
  });

  it('is refused to a check\'s space, which owns no machine, so a check never drives the person\'s own', async () => {
    await expect(resolveAgent()({ ownerId: 'space-of-user-1', agentSlug: 'delivery', modelId: 'machine:d1:antigravity' }))
      .rejects.toThrow(/not one of yours/);
  });

  it('is refused by a worker that cannot tell whose a machine is', async () => {
    const blind = createEngineActivities({ registry: createAgentRegistry() } as never).EngineResolveAgentActivity;
    await expect(blind({ ownerId: 'user-1', agentSlug: 'delivery', modelId: 'machine:d1:antigravity' })).rejects.toThrow(/cannot reach people's machines/);
  });
});
