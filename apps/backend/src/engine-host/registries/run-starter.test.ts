import { describe, it, expect, vi } from 'vitest';
import { AccountClosingError, createRunStarter } from './run-starter.js';
import { createAgentRegistry } from './registry.js';

const turns = () => ({ open: vi.fn(async () => undefined), fail: vi.fn(async () => undefined) });

describe('starting a run that is a conversation turn', () => {
  it('opens the turn on the conversation before its run starts', async () => {
    const order: string[] = [];
    const t = turns();
    t.open.mockImplementation(async () => { order.push('open'); });
    const runs = createRunStarter({
      registry: createAgentRegistry(),
      workflows: () => ({ start: async () => { order.push('start'); return { workflowId: 'run-1' }; } }),
      newRunId: () => 'run-1',
      turns: t,
    });

    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'hello', conversationId: 'c1' });

    expect(t.open).toHaveBeenCalledWith({ ownerId: 'u1', conversationId: 'c1', runId: 'run-1', message: 'hello' });
    expect(order).toEqual(['open', 'start']);
  });

  it('opens nothing for a run that does not save a conversation, or has none', async () => {
    const t = turns();
    const runs = createRunStarter({ registry: createAgentRegistry(), workflows: () => ({ start: async () => ({ workflowId: 'x' }) }), turns: t });

    await runs.start({ ownerId: 'u1', agentSlug: 'research', message: 'look it up', conversationId: 'c1' });
    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'hello' });

    expect(t.open).not.toHaveBeenCalled();
  });

  it('closes the turn with why when its run cannot start', async () => {
    const t = turns();
    const runs = createRunStarter({
      registry: createAgentRegistry(),
      workflows: () => ({ start: async () => { throw new Error('Temporal is down'); } }),
      newRunId: () => 'run-1',
      turns: t,
    });

    await expect(runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'hello', conversationId: 'c1' })).rejects.toThrow('Temporal is down');
    expect(t.fail).toHaveBeenCalledWith({ ownerId: 'u1', conversationId: 'c1', runId: 'run-1' }, 'the run could not start: Temporal is down');
  });
});

describe('an account being removed', () => {
  it('starts no new run, so nothing writes after its records are gone', async () => {
    const start = vi.fn(async () => ({ workflowId: 'x' }))
    const runs = createRunStarter({ registry: createAgentRegistry(), workflows: () => ({ start }), closing: async (ownerId) => (ownerId === 'leaving' ? 'it is being removed' : undefined) });

    await expect(runs.start({ ownerId: 'leaving', agentSlug: 'koala', message: 'hello' })).rejects.toBeInstanceOf(AccountClosingError);
    expect(start).not.toHaveBeenCalled();
    await runs.start({ ownerId: 'staying', agentSlug: 'koala', message: 'hello' });
    expect(start).toHaveBeenCalledTimes(1);
  });
});
