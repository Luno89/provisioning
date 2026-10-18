import { describe, expect, it } from 'vitest';
import { createEngineActivities } from './activities.js';
import { createAgentRegistry } from '../registries/registry.js';

const resolveAgent = () => createEngineActivities({ registry: createAgentRegistry() } as never).EngineResolveAgentActivity;

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
