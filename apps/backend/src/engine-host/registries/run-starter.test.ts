import { describe, it, expect, vi } from 'vitest';
import { AccountClosingError, createRunStarter, MachineUnavailableError } from './run-starter.js';
import type { ProcedureRunInput } from '../temporal/contracts.js';
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

  it('keeps a message\'s attachments on the person\'s message, and tells the run where each is', async () => {
    const start = vi.fn(async (_type: string, _options: { args: unknown[] }) => ({ workflowId: 'run-1' }));
    const t = turns();
    const runs = createRunStarter({ registry: createAgentRegistry(), workflows: () => ({ start }), newRunId: () => 'run-1', turns: t });
    const attachments = [{ name: 'brief.pdf', path: 'attachments/brief.pdf', type: 'application/pdf', project: { id: 'p1', name: 'Shop' } }];

    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'see this', conversationId: 'c1', attachments });

    expect(t.open).toHaveBeenCalledWith({ ownerId: 'u1', conversationId: 'c1', runId: 'run-1', message: 'see this', attachments });
    const input = start.mock.calls[0]![1].args[0] as ProcedureRunInput;
    expect(input.inputs.message).toBe('see this\n\nAttached to this message (read each with read_stored_file, naming the project and the path):\n- brief.pdf (application/pdf), in the project Shop\'s files at attachments/brief.pdf');
  });

    it('hands the run the conversation its turn was opened in, whatever the inputs said', async () => {
    const start = vi.fn(async (_type: string, _options: { args: unknown[] }) => ({ workflowId: 'run-1' }));
    const runs = createRunStarter({ registry: createAgentRegistry(), workflows: () => ({ start }), newRunId: () => 'run-1', turns: turns() });

    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'hello', conversationId: 'c1' });
    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'hello', conversationId: 'c1', inputs: { conversationId: 'c2' } });

    expect(start.mock.calls.map(([, options]) => (options.args[0] as ProcedureRunInput).inputs.conversationId)).toEqual(['c1', 'c1']);
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

describe('a run whose workflow is kept for one run at a time', () => {
  it('starts under the workflow its run id belongs to, remembers the run id, its agent, conversation and what it is about, and is reached through that workflow', async () => {
    const start = vi.fn(async (_type: string, options: { workflowId: string }) => ({ workflowId: options.workflowId }));
    const signal = vi.fn(async () => undefined);
    const runs = createRunStarter({ registry: createAgentRegistry(), workflows: () => ({ start, signal }) });

    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'grow', runId: 'grove-run-t1~k2x9', conversationId: 'c1', about: 'the tree "Shop"' });
    expect(start).toHaveBeenCalledWith('AgentRunWorkflow', expect.objectContaining({ workflowId: 'grove-run-t1', memo: { runId: 'grove-run-t1~k2x9', agent: 'koala', conversation: 'c1', about: 'the tree "Shop"' } }));

    await runs.cancel('grove-run-t1~k2x9');
    await runs.cancel('grove-run-t1~k2x9-grove-leaf-1');
    expect(signal.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['grove-run-t1', 'grove-run-t1~k2x9-grove-leaf-1']);
  });
});

describe('a run sent to an agent on the person\'s machine', () => {
  const started = () => {
    const runs: { args: unknown[] }[] = [];
    return { runs, start: async (_type: string, options: { args: unknown[] }) => { runs.push(options); return { workflowId: 'x' }; } };
  };

  it('runs a chat turn through the chat procedure on that machine, after checking the machine can answer', async () => {
    const { runs, start } = started();
    const asked: unknown[] = [];
    const starter = createRunStarter({ registry: createAgentRegistry(), workflows: () => ({ start }), machines: async (ownerId, choice) => { asked.push([ownerId, choice]); return undefined; } });

    const run = await starter.start({ ownerId: 'bo', agentSlug: 'koala', message: 'hi', conversationId: 'c1', modelId: 'machine:d1:antigravity' });

    expect(run.loopId).toBe('external-agent-chat');
    expect(asked).toEqual([['bo', { deviceId: 'd1', agent: 'antigravity' }]]);
    expect((runs[0]!.args[0] as ProcedureRunInput).ticket.modelId).toBe('machine:d1:antigravity');
  });

  it('keeps an agent\'s own procedure when it hands its work to a machine, and hands anything else to the task procedure', async () => {
    const { start } = started();
    const starter = createRunStarter({ registry: createAgentRegistry(), workflows: () => ({ start }), machines: async () => undefined });
    expect((await starter.start({ ownerId: 'bo', agentSlug: 'executor', message: 'do it', modelId: 'machine:d1:antigravity' })).loopId).toBe('do-one-task');
    expect((await starter.start({ ownerId: 'bo', agentSlug: 'memory-keeper', message: 'keep it', modelId: 'machine:d1:antigravity' })).loopId).toBe('tool-rounds');
    expect((await starter.start({ ownerId: 'bo', agentSlug: 'koala', message: 'look into it', modelId: 'machine:d1:antigravity' })).loopId).toBe('external-agent-task');
  });

  it('starts nothing when the machine cannot answer, and says why', async () => {
    const { runs, start } = started();
    const starter = createRunStarter({ registry: createAgentRegistry(), workflows: () => ({ start }), machines: async () => 'desk is not connected, so Antigravity cannot answer' });
    await expect(starter.start({ ownerId: 'bo', agentSlug: 'koala', message: 'hi', conversationId: 'c1', modelId: 'machine:d1:antigravity' }))
      .rejects.toThrow(new MachineUnavailableError('desk is not connected, so Antigravity cannot answer'));
    await expect(createRunStarter({ registry: createAgentRegistry(), workflows: () => ({ start }) }).start({ ownerId: 'bo', agentSlug: 'koala', message: 'hi', modelId: 'machine:d1:antigravity' }))
      .rejects.toThrow(MachineUnavailableError);
    expect(runs).toHaveLength(0);
  });
});

describe('a run Koala does for a member of a shared project', () => {
  const member = { personId: 'cy', email: 'cy@example.com', role: 'client', projectId: 'p1', hubProjectId: 'h1' };
  const started = () => {
    const runs: { args: unknown[] }[] = [];
    return { runs, start: async (_type: string, options: { args: unknown[] }) => { runs.push(options); return { workflowId: 'x' }; } };
  };

  it('carries who it is for into the run, pinned to their project, names them to Koala and asks about only their own note', async () => {
    const { runs, start } = started();
    const t = turns();
    const binding = vi.fn(async () => ({ chat: 'someone is asking' }));
    const starter = createRunStarter({ registry: createAgentRegistry(), workflows: () => ({ start }), newRunId: () => 'run-1', turns: t, binding });
    await starter.start({ ownerId: 'ann', actingFor: member, agentSlug: 'koala', message: 'make it green', conversationId: 'channel-p1', asks: 'at-1', inputs: { projectId: 'p2' } });
    const input = runs[0]!.args[0] as ProcedureRunInput;
    expect(input.ticket).toMatchObject({ ownerId: 'ann', actingFor: member, projectId: 'p1' });
    expect(input.projectId).toBe('p1');
    expect(input.inputs.projectId).toBeUndefined();
    expect(binding).toHaveBeenCalledWith('ann', 'channel-p1', member);
    expect(t.open).toHaveBeenCalledWith(expect.objectContaining({ asks: 'at-1', askedBy: 'cy' }));
  });

  it('never goes to the owner\'s machine: a machine picked for the chat gives way to the owner\'s default, and a default on a machine is refused', async () => {
    const { runs, start } = started();
    const machines = vi.fn(async () => undefined);
    const plain = createRunStarter({ registry: createAgentRegistry({ accountDefault: async () => ({ modelId: 'ep.qwen' }) }), workflows: () => ({ start }), machines });
    await plain.start({ ownerId: 'ann', actingFor: member, agentSlug: 'koala', message: 'hi', conversationId: 'c1', modelId: 'machine:d1:antigravity' });
    expect((runs[0]!.args[0] as ProcedureRunInput).ticket.modelId).toBeUndefined();
    expect((runs[0]!.args[0] as ProcedureRunInput).procedure.id).not.toBe('external-agent-chat');
    expect(machines).not.toHaveBeenCalled();

    const onMachine = createRunStarter({ registry: createAgentRegistry({ accountDefault: async () => ({ modelId: 'machine:d1:claude-code' }) }), workflows: () => ({ start }), machines });
    await expect(onMachine.start({ ownerId: 'ann', actingFor: member, agentSlug: 'koala', message: 'hi', conversationId: 'c1' })).rejects.toThrow(/never on the owner's machine/);
    expect(runs).toHaveLength(1);
    await onMachine.start({ ownerId: 'ann', agentSlug: 'koala', message: 'hi', conversationId: 'c1' });
    expect((runs[1]!.args[0] as ProcedureRunInput).ticket.modelId).toBe('machine:d1:claude-code');
  });

  it('keeps the memory keeper to a project when others talked, and never acts for anyone then', async () => {
    const { runs, start } = started();
    await createRunStarter({ registry: createAgentRegistry(), workflows: () => ({ start }) }).start({ ownerId: 'ann', keptTo: 'p1', agentSlug: 'memory-keeper', message: 'keep it' });
    expect((runs[0]!.args[0] as ProcedureRunInput).ticket).toMatchObject({ keptTo: 'p1', projectId: 'p1' });
    expect((runs[0]!.args[0] as ProcedureRunInput).ticket.actingFor).toBeUndefined();
  });
});
