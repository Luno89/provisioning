import { describe, it, expect, vi } from 'vitest';
import { createRunStarter, MachineUnavailableError } from './run-starter.js';
import type { ProcedureRunInput } from '../temporal/contracts.js';
import { createAgentRegistry } from './registry.js';
import { grantsHeldInMemory, runsActingAsTheirOwner } from '../../engine/testing/run-grants.js';
import { asPerson } from '../../platform/lib/permissions.js';

const turns = () => ({ open: vi.fn(async () => undefined), fail: vi.fn(async () => undefined) });

describe('the grant every run starts with', () => {
  it('is issued for whoever the run acts for and whoever started it, and the ticket names only the grant', async () => {
    const grants = grantsHeldInMemory();
    const start = vi.fn(async (_type: string, _options: { args: unknown[] }) => ({ workflowId: 'x' }));
    const runs = createRunStarter({ ...runsActingAsTheirOwner(grants), registry: createAgentRegistry(), workflows: () => ({ start }) });
    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'hello', startedBy: 'person' });
    const { ticket } = start.mock.calls[0]![1].args[0] as ProcedureRunInput;
    expect(ticket).not.toHaveProperty('principal');
    expect(await grants.grant(ticket.grantId)).toMatchObject({ runId: ticket.runId, principal: asPerson('u1'), startedBy: 'person', state: 'live' });
  });
});

describe('starting a run that is a conversation turn', () => {
  it('opens the turn on the conversation before its run starts', async () => {
    const order: string[] = [];
    const t = turns();
    t.open.mockImplementation(async () => { order.push('open'); });
    const runs = createRunStarter({
      ...runsActingAsTheirOwner(),
      registry: createAgentRegistry(),
      workflows: () => ({ start: async () => { order.push('start'); return { workflowId: 'run-1' }; } }),
      newRunId: () => 'run-1',
      turns: t,
    });

    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'hello', startedBy: 'person', conversationId: 'c1' });

    expect(t.open).toHaveBeenCalledWith({ ownerId: 'u1', conversationId: 'c1', runId: 'run-1', message: 'hello' });
    expect(order).toEqual(['open', 'start']);
  });

  it('keeps a message\'s attachments on the person\'s message, and tells the run where each is', async () => {
    const start = vi.fn(async (_type: string, _options: { args: unknown[] }) => ({ workflowId: 'run-1' }));
    const t = turns();
    const runs = createRunStarter({ ...runsActingAsTheirOwner(), registry: createAgentRegistry(), workflows: () => ({ start }), newRunId: () => 'run-1', turns: t });
    const attachments = [{ fileId: 'f1', name: 'brief.pdf', type: 'application/pdf', project: { id: 'p1', name: 'Shop' } }];

    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'see this', startedBy: 'person', conversationId: 'c1', attachments });

    expect(t.open).toHaveBeenCalledWith({ ownerId: 'u1', conversationId: 'c1', runId: 'run-1', message: 'see this', attachments });
    const input = start.mock.calls[0]![1].args[0] as ProcedureRunInput;
    expect(input.inputs.message).toBe('see this\n\nAttached to this message (read each with read_stored_file, giving its file id as fileId):\n- brief.pdf (application/pdf), in the project Shop\'s files, file id f1');
  });

    it('hands the run the conversation its turn was opened in, whatever the inputs said', async () => {
    const start = vi.fn(async (_type: string, _options: { args: unknown[] }) => ({ workflowId: 'run-1' }));
    const runs = createRunStarter({ ...runsActingAsTheirOwner(), registry: createAgentRegistry(), workflows: () => ({ start }), newRunId: () => 'run-1', turns: turns() });

    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'hello', startedBy: 'person', conversationId: 'c1' });
    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'hello', startedBy: 'person', conversationId: 'c1', inputs: { conversationId: 'c2' } });

    expect(start.mock.calls.map(([, options]) => (options.args[0] as ProcedureRunInput).inputs.conversationId)).toEqual(['c1', 'c1']);
  });

  it('opens nothing for a run that does not save a conversation, or has none', async () => {
    const t = turns();
    const runs = createRunStarter({ ...runsActingAsTheirOwner(), registry: createAgentRegistry(), workflows: () => ({ start: async () => ({ workflowId: 'x' }) }), turns: t });

    await runs.start({ ownerId: 'u1', agentSlug: 'research', message: 'look it up', startedBy: 'person', conversationId: 'c1' });
    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'hello', startedBy: 'person' });

    expect(t.open).not.toHaveBeenCalled();
  });

  it('closes the turn with why when its run cannot start', async () => {
    const t = turns();
    const runs = createRunStarter({
      ...runsActingAsTheirOwner(),
      registry: createAgentRegistry(),
      workflows: () => ({ start: async () => { throw new Error('Temporal is down'); } }),
      newRunId: () => 'run-1',
      turns: t,
    });

    await expect(runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'hello', startedBy: 'person', conversationId: 'c1' })).rejects.toThrow('Temporal is down');
    expect(t.fail).toHaveBeenCalledWith({ ownerId: 'u1', conversationId: 'c1', runId: 'run-1' }, 'the run could not start: Temporal is down');
  });
});


describe('a run that works for a project', () => {
  it('names the project it works for when it starts, so deleting the project fences what the run still does', async () => {
    const start = vi.fn(async (_type: string, _options: { project?: string | undefined }) => ({ workflowId: 'x' }));
    const runs = createRunStarter({ ...runsActingAsTheirOwner(), registry: createAgentRegistry(), workflows: () => ({ start }), binding: async () => ({ projectId: 'p3', treeId: 't3' }) });

    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'grow', startedBy: 'person', projectId: 'p1', bound: { treeId: 't1' } });
    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'release', startedBy: 'person', bound: { projectId: 'p2' } });
    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'hello', startedBy: 'person', conversationId: 'c3' });
    await runs.start({ ownerId: 'u1', agentSlug: 'research', message: 'look it up', startedBy: 'person' });

    expect(start.mock.calls.map(([, options]) => options.project)).toEqual(['p1', 'p2', 'p3', undefined]);
  });
});

describe('a run whose workflow is kept for one run at a time', () => {
  it('starts under the workflow its run id belongs to, remembers the run id, its agent, conversation and what it is about, and is reached through that workflow', async () => {
    const start = vi.fn(async (_type: string, options: { workflowId: string }) => ({ workflowId: options.workflowId }));
    const signal = vi.fn(async () => undefined);
    const runs = createRunStarter({ ...runsActingAsTheirOwner(), registry: createAgentRegistry(), workflows: () => ({ start, signal }) });

    await runs.start({ ownerId: 'u1', agentSlug: 'koala', message: 'grow', startedBy: 'person', runId: 'grove-run-t1~k2x9', conversationId: 'c1', about: 'the tree "Shop"' });
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
    const starter = createRunStarter({ ...runsActingAsTheirOwner(), registry: createAgentRegistry(), workflows: () => ({ start }), machines: async (ownerId, choice) => { asked.push([ownerId, choice]); return undefined; } });

    const run = await starter.start({ ownerId: 'bo', agentSlug: 'koala', message: 'hi', startedBy: 'person', conversationId: 'c1', modelId: 'machine:d1:antigravity' });

    expect(run.loopId).toBe('external-agent-chat');
    expect(asked).toEqual([['bo', { deviceId: 'd1', agent: 'antigravity' }]]);
    expect((runs[0]!.args[0] as ProcedureRunInput).ticket.modelId).toBe('machine:d1:antigravity');
  });

  it('keeps an agent\'s own procedure when it hands its work to a machine, and hands anything else to the task procedure', async () => {
    const { start } = started();
    const starter = createRunStarter({ ...runsActingAsTheirOwner(), registry: createAgentRegistry(), workflows: () => ({ start }), machines: async () => undefined });
    expect((await starter.start({ ownerId: 'bo', agentSlug: 'executor', message: 'do it', startedBy: 'person', modelId: 'machine:d1:antigravity' })).loopId).toBe('do-one-task');
    expect((await starter.start({ ownerId: 'bo', agentSlug: 'memory-keeper', message: 'keep it', startedBy: 'person', modelId: 'machine:d1:antigravity' })).loopId).toBe('tool-rounds');
    expect((await starter.start({ ownerId: 'bo', agentSlug: 'koala', message: 'look into it', startedBy: 'person', modelId: 'machine:d1:antigravity' })).loopId).toBe('external-agent-task');
  });

  it('starts nothing when the machine cannot answer, and says why', async () => {
    const { runs, start } = started();
    const starter = createRunStarter({ ...runsActingAsTheirOwner(), registry: createAgentRegistry(), workflows: () => ({ start }), machines: async () => 'desk is not connected, so Antigravity cannot answer' });
    await expect(starter.start({ ownerId: 'bo', agentSlug: 'koala', message: 'hi', startedBy: 'person', conversationId: 'c1', modelId: 'machine:d1:antigravity' }))
      .rejects.toThrow(new MachineUnavailableError('desk is not connected, so Antigravity cannot answer'));
    await expect(createRunStarter({ ...runsActingAsTheirOwner(), registry: createAgentRegistry(), workflows: () => ({ start }) }).start({ ownerId: 'bo', agentSlug: 'koala', message: 'hi', startedBy: 'person', modelId: 'machine:d1:antigravity' }))
      .rejects.toThrow(MachineUnavailableError);
    expect(runs).toHaveLength(0);
  });
});

describe('the grant a run starts with', () => {
  it('narrows to a project only where access stops there: a tree\'s run, never the owner\'s chat because it is bound to one', async () => {
    const start = async () => ({ workflowId: 'x' });
    const issued: { projectId?: string | undefined }[] = [];
    const grants = { issue: vi.fn(async (request: { projectId?: string | undefined }) => { issued.push(request); return { id: `g${issued.length}` }; }) };
    const binding = vi.fn(async () => ({ projectId: 'p1', chat: 'the project channel' }));
    const starter = createRunStarter({ principal: runsActingAsTheirOwner().principal, registry: createAgentRegistry(), workflows: () => ({ start }), turns: turns(), binding, grants: grants as never });
    await starter.start({ ownerId: 'ann', agentSlug: 'koala', message: 'and the other project?', conversationId: 'channel-p1', startedBy: 'person' });
    await starter.start({ ownerId: 'ann', agentSlug: 'koala', message: 'Grow the tree.', projectId: 'p1', startedBy: 'person' });
    expect(issued.map((request) => request.projectId)).toEqual([undefined, 'p1']);
  });
});

describe('two processes starting the same run at once', () => {
  it('withdraws the grant of the start Temporal refused, so only the run that started holds one', async () => {
    const issued: string[] = [];
    const withdrawn: string[] = [];
    const grants = {
      issue: vi.fn(async () => { const id = `g${issued.length + 1}`; issued.push(id); return { id }; }),
      withdraw: vi.fn(async (id: string) => { withdrawn.push(id); }),
    };
    let release!: () => void;
    const bothIssued = new Promise<void>((resolve) => { release = resolve; });
    let waiting = 0;
    const tickets: (string | undefined)[] = [];
    const start = vi.fn(async (_type: string, options: { args: unknown[] }) => {
      waiting += 1;
      if (waiting === 2) release();
      await bothIssued;
      if (tickets.length > 0) throw new Error('Workflow execution already started');
      tickets.push((options.args[0] as ProcedureRunInput).ticket.grantId);
      return { workflowId: 'run-same' };
    });
    const first = createRunStarter({ principal: runsActingAsTheirOwner().principal, registry: createAgentRegistry(), workflows: () => ({ start }), grants });
    const second = createRunStarter({ principal: runsActingAsTheirOwner().principal, registry: createAgentRegistry(), workflows: () => ({ start }), grants });

    const [won, lost] = await Promise.allSettled([
      first.start({ ownerId: 'ann', agentSlug: 'research', message: 'look it up', startedBy: 'person', runId: 'run-same' }),
      second.start({ ownerId: 'ann', agentSlug: 'research', message: 'look it up', startedBy: 'person', runId: 'run-same' }),
    ]);

    expect(won.status).toBe('fulfilled');
    expect(lost.status).toBe('rejected');
    expect(issued).toEqual(['g1', 'g2']);
    expect(tickets).toEqual(['g1']);
    expect(withdrawn).toEqual(['g2']);
  });
});
