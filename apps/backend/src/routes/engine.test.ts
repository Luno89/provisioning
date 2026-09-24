import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { engineRouter } from './engine.js';
import { createAgentRegistry, createRunStarter, type WorkflowStarter, type Task } from '../engine-host/index.js';
import type { Database } from '../lib/db-interface.js';
import { INTERACTIVE_CHAT_V3, RESEARCH_V2 } from '@koala/agent-engine/procedure';

let tasks: Task[] = [];

const taskAccess = {
  list: async (ownerId: string) => tasks.filter((task) => task.ownerId === ownerId),
  save: async (task: Task) => {
    const index = tasks.findIndex((candidate) => candidate.id === task.id);
    if (index >= 0) tasks[index] = task;
    else tasks.push(task);
  },
};

const seedTask = (over: Partial<Task> & Pick<Task, 'id'>): Task => {
  const task: Task = {
    ownerId: 'test-user',
    title: over.id,
    doneMeans: 'it works',
    dependsOn: [],
    status: 'proposed',
    runs: [],
    createdAt: 'now',
    updatedAt: 'now',
    ...over,
  };
  tasks.push(task);
  return task;
};

beforeEach(() => {
  tasks = [];
});


function harnessWith(workflows: WorkflowStarter | undefined) {
  const registry = createAgentRegistry();
  const runs = createRunStarter({
    registry,
    workflows: () => workflows,
    newRunId: () => 'run-fixed',
  });

  return mountRouter({
    prefix: '/api/engine',
    router: (db) => {
      return engineRouter({ runs, registry, tasks: taskAccess, traces: { list: (ownerId, runId) => db.getRunTraces(ownerId, runId) } });
    },
  });
}

const starter = (): WorkflowStarter & { start: ReturnType<typeof vi.fn>; signal: ReturnType<typeof vi.fn> } => ({
  start: vi.fn(async (_type: string, options: { workflowId: string }) => ({ workflowId: options.workflowId })),
  signal: vi.fn(async () => undefined),
});

describe('engine routes', () => {
  it('lists the agents a user can run', async () => {
    const workflows = starter();
    const h: Harness = await harnessWith(workflows);

    const res = await axios.get(h.url('/api/engine/agents'));

    expect(res.status).toBe(200);
    expect(res.data.map((a: { slug: string }) => a.slug).sort())
      .toEqual(['agent-builder', 'delivery', 'executor', 'grove-runner', 'judge', 'koala', 'leaf-judge', 'planner', 'research']);
    expect(res.data.find((a: { slug: string }) => a.slug === 'koala')).toMatchObject({ mine: false });

    await h.close();
  });

  it('starts a run and reports which loop it is running', async () => {
    const workflows = starter();
    const h: Harness = await harnessWith(workflows);

    const res = await axios.post(h.url('/api/engine/runs'), { agent: 'koala', message: 'hello there' });

    expect(res.status).toBe(201);
    expect(res.data).toEqual({ runId: 'run-fixed', agentSlug: 'koala', loopId: 'interactive-chat' });

    expect(workflows.start).toHaveBeenCalledWith('AgentRunWorkflow', expect.objectContaining({
      workflowId: 'run-fixed',
      taskQueue: 'engine-queue',
    }));

    const [, options] = workflows.start.mock.calls[0] as [string, { args: [Record<string, unknown>] }];
    expect(options.args[0]).toEqual({
      ticket: { runId: 'run-fixed', depth: 0, ownerId: 'test-user', agentSlug: 'koala', trigger: 'user' },
      procedure: INTERACTIVE_CHAT_V3,
      inputs: { message: 'hello there' },
    });

    await h.close();
  });

  it('runs a chosen procedure in place of the agent\'s own, and says when that procedure does not exist', async () => {
    const workflows = starter();
    const h: Harness = await harnessWith(workflows);

    const res = await axios.post(h.url('/api/engine/runs'), { agent: 'koala', message: 'hi', procedure: 'research' });
    const [, options] = workflows.start.mock.calls[0] as [string, { args: [{ procedure: { id: string } }] }];

    expect(res.status).toBe(201);
    expect(options.args[0].procedure).toEqual(RESEARCH_V2);
    await expect(axios.post(h.url('/api/engine/runs'), { agent: 'koala', message: 'hi', procedure: 'nowhere' }))
      .rejects.toMatchObject({ response: { status: 404, data: { error: expect.stringContaining('nowhere') } } });

    await h.close();
  });

  it('rejects a run with no agent or no message', async () => {
    const h: Harness = await harnessWith(starter());

    await expect(axios.post(h.url('/api/engine/runs'), { message: 'hi' }))
      .rejects.toMatchObject({ response: { status: 400 } });
    await expect(axios.post(h.url('/api/engine/runs'), { agent: 'koala', message: '  ' }))
      .rejects.toMatchObject({ response: { status: 400 } });

    await h.close();
  });

  it('says which agent is missing rather than failing obscurely', async () => {
    const h: Harness = await harnessWith(starter());

    await expect(axios.post(h.url('/api/engine/runs'), { agent: 'ghost', message: 'hi' }))
      .rejects.toMatchObject({ response: { status: 404, data: { error: expect.stringContaining('ghost') } } });

    await h.close();
  });

  it('reports plainly when Temporal is not connected instead of hanging', async () => {
    const h: Harness = await harnessWith(undefined);

    await expect(axios.post(h.url('/api/engine/runs'), { agent: 'koala', message: 'hi' }))
      .rejects.toMatchObject({ response: { status: 503 } });

    await h.close();
  });

  it('returns only the caller\'s traces for a run, in order', async () => {
    let db: Database | undefined;
    const h = await mountRouter({
      prefix: '/api/engine',
      router: (database) => {
        db = database;
        return engineRouter({ runs: createRunStarter({ registry: createAgentRegistry(), workflows: () => undefined }), registry: createAgentRegistry(), traces: { list: (ownerId, runId) => database.getRunTraces(ownerId, runId) } });
      },
    });
    const trace = (sequence: number, ownerId: string) => ({
      sequence, step: sequence, node: `n${sequence}`, origin: `n${sequence}`, kind: 'finish', role: 'step' as const, cleanup: false,
      startedAt: 0, durationMs: 1, inputs: {}, runId: 'run-1', ownerId, agentSlug: 'koala', procedureId: 'p', procedureVersion: '1',
    });
    await db!.saveRunTraces([trace(2, TEST_USER.id), trace(1, TEST_USER.id), trace(3, 'someone-else')]);

    const res = await axios.get(h.url('/api/engine/runs/run-1/traces'));

    expect(res.data.traces.map((entry: { node: string }) => entry.node)).toEqual(['n1', 'n2']);
    await h.close();
  });

  it('signals an answer back into a waiting run', async () => {
    const workflows = starter();
    const h: Harness = await harnessWith(workflows);

    const res = await axios.post(h.url('/api/engine/runs/run-1/answer'), { nodeId: 'ask', value: 'staging' });

    expect(res.status).toBe(200);
    expect(workflows.signal).toHaveBeenCalledWith('run-1', 'answer', { nodeId: 'ask', value: 'staging' });

    await h.close();
  });

  it('signals an approval decision, carrying whether it stands for the rest of the run', async () => {
    const workflows = starter();
    const h: Harness = await harnessWith(workflows);

    await axios.post(h.url('/api/engine/runs/run-1/approve'), { callId: 'c1', allowed: true, forRun: true });

    expect(workflows.signal).toHaveBeenCalledWith('run-1', 'approve', { callId: 'c1', allowed: true, forRun: true });

    await h.close();
  });

  it('requires an explicit allow or deny on an approval', async () => {
    const h: Harness = await harnessWith(starter());

    await expect(axios.post(h.url('/api/engine/runs/run-1/approve'), { callId: 'c1' }))
      .rejects.toMatchObject({ response: { status: 400 } });

    await h.close();
  });

  it('lists work with whether it can start and what it is waiting on', async () => {
    seedTask({ id: 'first', status: 'running' });
    seedTask({ id: 'second', status: 'accepted', dependsOn: ['first'] });
    seedTask({ id: 'third', status: 'accepted' });

    const h: Harness = await harnessWith(starter());
    const res = await axios.get(h.url('/api/engine/tasks'));

    const second = res.data.find((task: { id: string }) => task.id === 'second');
    const third = res.data.find((task: { id: string }) => task.id === 'third');

    expect(second).toMatchObject({ ready: false });
    expect(second.waitingOn).toEqual([{ id: 'first', title: 'first', status: 'running' }]);
    expect(third).toMatchObject({ ready: true, waitingOn: [] });

    await h.close();
  });

  it('filters work by status', async () => {
    seedTask({ id: 'a', status: 'proposed' });
    seedTask({ id: 'b', status: 'done' });

    const h: Harness = await harnessWith(starter());
    const res = await axios.get(h.url('/api/engine/tasks?status=proposed'));

    expect(res.data.map((task: { id: string }) => task.id)).toEqual(['a']);

    await h.close();
  });

  it('accepts proposed work so a run can pick it up', async () => {
    seedTask({ id: 'a', status: 'proposed' });

    const h: Harness = await harnessWith(starter());
    const res = await axios.post(h.url('/api/engine/tasks/a/accept'), {});

    expect(res.data.status).toBe('accepted');
    expect(tasks[0]?.status).toBe('accepted');

    await h.close();
  });

  it('drops work without pretending it happened', async () => {
    seedTask({ id: 'a', status: 'proposed' });

    const h: Harness = await harnessWith(starter());
    await axios.post(h.url('/api/engine/tasks/a/drop'), {});

    expect(tasks[0]?.status).toBe('dropped');

    await h.close();
  });

  it('says which task is missing', async () => {
    const h: Harness = await harnessWith(starter());

    await expect(axios.post(h.url('/api/engine/tasks/ghost/accept'), {}))
      .rejects.toMatchObject({ response: { status: 404 } });

    await h.close();
  });

  it('never shows one person another person\'s work', async () => {
    seedTask({ id: 'mine' });
    tasks.push({
      id: 'theirs', ownerId: 'someone-else', title: 'Not yours', doneMeans: 'x',
      dependsOn: [], status: 'proposed', runs: [], createdAt: 'now', updatedAt: 'now',
    });

    const h: Harness = await harnessWith(starter());
    const res = await axios.get(h.url('/api/engine/tasks'));

    expect(res.data.map((task: { id: string }) => task.id)).toEqual(['mine']);

    await h.close();
  });

  it('cancels a run', async () => {
    const workflows = starter();
    const h: Harness = await harnessWith(workflows);

    await axios.post(h.url('/api/engine/runs/run-1/cancel'), {});

    expect(workflows.signal).toHaveBeenCalledWith('run-1', 'cancelRun', undefined);

    await h.close();
  });

  it('starts a run with modelId and passes it to workflow ticket', async () => {
    const workflows = starter();
    const h: Harness = await harnessWith(workflows);

    const res = await axios.post(h.url('/api/engine/runs'), {
      agent: 'executor',
      message: 'test command',
      modelId: 'test-model-123',
    });

    expect(res.status).toBe(201);
    expect(workflows.start).toHaveBeenCalledWith('AgentRunWorkflow', expect.objectContaining({
      args: [expect.objectContaining({
        ticket: expect.objectContaining({
          modelId: 'test-model-123',
        }),
      })],
    }));

    await h.close();
  });

  it('turns a temperature into sampling for both kinds of turn, and refuses one out of range', async () => {
    const workflows = starter();
    const h: Harness = await harnessWith(workflows);

    const started = await axios.post(h.url('/api/engine/runs'), {
      agent: 'executor',
      message: 'test command',
      temperature: 0.4,
    });
    expect(started.status).toBe(201);
    expect(workflows.start).toHaveBeenCalledWith('AgentRunWorkflow', expect.objectContaining({
      args: [expect.objectContaining({
        ticket: expect.objectContaining({
          sampling: { toolTurn: { temperature: 0.4 }, conversation: { temperature: 0.4 } },
        }),
      })],
    }));

    const refused = await axios.post(h.url('/api/engine/runs'), {
      agent: 'executor',
      message: 'test command',
      temperature: 5,
    }, { validateStatus: () => true });
    expect(refused.status).toBe(400);

    await h.close();
  });

});
