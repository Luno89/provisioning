import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { AgentRunWorkflow, answerSignal, approveSignal, cancelSignal, type AgentRunInput } from './AgentRunWorkflow.js';
import type { LoopGraph } from '../engine/graph.js';
import type { ModelCallOutcome } from '../engine/temporal/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const reply = (over: Partial<ModelCallOutcome> = {}): ModelCallOutcome => ({
  content: 'all done',
  thinking: '',
  toolCalls: [],
  finishReason: 'stop',
  ...over,
});

const input = (graph: LoopGraph, over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  ticket: {
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    depth: 0,
    ownerId: 'user-1',
    agentSlug: 'koala',
    trigger: 'user',
  },
  graph,
  budget: graph.budget ?? { maxRounds: 5 },
  messages: [{ role: 'user', content: 'hello' }],
  ...over,
});

const researchLoop: LoopGraph = {
  id: 'research', version: '1', entry: 'ask',
  budget: { maxRounds: 3 },
  nodes: [
    { kind: 'model', id: 'ask', tools: 'granted', next: [{ to: 'answered' }] },
    { kind: 'terminal', id: 'answered', outcome: 'ok' },
  ],
};

function activities(over: Record<string, unknown> = {}) {
  return {
    EngineResolveEnvironmentActivity: vi.fn(async () => ({
      kind: 'sandbox' as const,
      id: 'engine-sandbox-1',
      spec: { kind: 'sandbox' as const, lifecycle: 'invocation' as const },
    })),
    EngineReleaseEnvironmentActivity: vi.fn(async () => undefined),
    EngineResolveAgentActivity: vi.fn(async () => ({
      found: true,
      graph: researchLoop,
      budget: { maxRounds: 3 },
      callableAgents: [],
    })),
    EngineModelCallActivity: vi.fn(async () => reply()),
    EngineToolActivity: vi.fn(async () => ({ ok: true, digest: 'tool ran', content: 'tool output' })),
    EngineTransformActivity: vi.fn(async () => ({})),
    EngineMergeActivity: vi.fn(async () => ({})),
    EnginePublishActivity: vi.fn(async () => undefined),
    ...over,
  };
}

async function runWorkflow(
  args: AgentRunInput,
  acts: Record<string, unknown>,
  drive?: (handle: Awaited<ReturnType<typeof env.client.workflow.start>>) => Promise<void>,
  deviceQueues: string[] = [],
) {
  const taskQueue = `engine-test-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: resolve(__dirname, 'AgentRunWorkflow.ts'),
    activities: acts,
  });

  deviceQueues = [...deviceQueues, 'engine-stream-queue'];

  const deviceWorkers = await Promise.all(deviceQueues.map((queue) => Worker.create({
    connection: env.nativeConnection,
    taskQueue: queue,
    activities: acts,
  })));

  const start = async () => {
    const handle = await env.client.workflow.start(AgentRunWorkflow, {
      args: [args],
      taskQueue,
      workflowId: args.ticket.runId,
    });
    if (drive) await drive(handle);
    return handle.result();
  };

  const withDeviceWorkers = deviceWorkers.reduce(
    (inner: () => Promise<Awaited<ReturnType<typeof start>>>, deviceWorker) =>
      () => deviceWorker.runUntil(inner()),
    start,
  );

  return worker.runUntil(withDeviceWorkers());
}

const simple: LoopGraph = {
  id: 'simple',
  version: '1',
  entry: 'think',
  budget: { maxRounds: 5 },
  nodes: [
    { kind: 'model', id: 'think', tools: 'granted', next: [{ to: 'done' }] },
    { kind: 'terminal', id: 'done', outcome: 'ok' },
  ],
};

describe('AgentRunWorkflow', () => {
  it('runs a loop to its terminal and returns the outcome', async () => {
    const acts = activities();
    const result = await runWorkflow(input(simple), acts);

    expect(result).toMatchObject({ outcome: 'ok', agentId: 'koala' });
    expect(acts.EngineModelCallActivity).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('runs the tool calls the model asked for, then finishes', async () => {
    let round = 0;
    const acts = activities({
      EngineModelCallActivity: vi.fn(async () => {
        round += 1;
        return round === 1
          ? reply({ content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: '{}' }] })
          : reply();
      }),
    });

    const graph: LoopGraph = {
      id: 'tools', version: '1', entry: 'think',
      budget: { maxRounds: 5 },
      nodes: [
        { kind: 'model', id: 'think', tools: 'granted', next: [
          { to: 'work', when: 'not empty(reply.toolCalls)' },
          { to: 'done' },
        ] },
        { kind: 'dispatch', id: 'work', next: [{ to: 'think' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    };

    const result = await runWorkflow(input(graph), acts);

    expect(result.outcome).toBe('ok');
    expect(acts.EngineToolActivity).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('pauses on a wait node and carries on once someone answers', async () => {
    const graph: LoopGraph = {
      id: 'asks', version: '1', entry: 'ask',
      budget: { maxRounds: 5 },
      nodes: [
        { kind: 'wait', id: 'ask', prompt: 'Which database?', as: 'answer', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    };

    const acts = activities();
    const result = await runWorkflow(input(graph), acts, async (handle) => {
      await handle.signal(answerSignal, { nodeId: 'ask', value: 'the staging one' });
    });

    expect(result.outcome).toBe('ok');
    expect(result.outputs.answer).toBe('the staging one');
    expect(acts.EnginePublishActivity).toHaveBeenCalled();
  }, 60_000);

  it('gives up on a wait that nobody ever answers, without blocking a worker', async () => {
    const graph: LoopGraph = {
      id: 'asks', version: '1', entry: 'ask',
      budget: { maxRounds: 5 },
      nodes: [
        { kind: 'wait', id: 'ask', prompt: 'Anyone there?', timeoutMs: 60_000, next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    };

    const result = await runWorkflow(input(graph), activities());

    expect(result).toMatchObject({ outcome: 'exhausted' });
    expect(result.reason).toMatch(/nobody answered/);
  }, 60_000);

  it('stops a waiting run when it is cancelled', async () => {
    const graph: LoopGraph = {
      id: 'asks', version: '1', entry: 'ask',
      budget: { maxRounds: 5 },
      nodes: [
        { kind: 'wait', id: 'ask', prompt: 'Still there?', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    };

    const result = await runWorkflow(input(graph), activities(), async (handle) => {
      await handle.signal(cancelSignal);
    });

    expect(result).toMatchObject({ outcome: 'exhausted' });
    expect(result.reason).toMatch(/cancelled/);
  }, 60_000);

  it('settles as interrupted when the model activity reports a monitor firing', async () => {
    const acts = activities({
      EngineModelCallActivity: vi.fn(async () => reply({ content: 'partial', interrupted: 'overthinking (overthinking)' })),
    });

    const result = await runWorkflow(input(simple), acts);

    expect(result).toMatchObject({ outcome: 'interrupted' });
    expect(result.reason).toMatch(/overthinking/);
  }, 60_000);

  it('runs a delegated agent as a child workflow using that agent\'s own loop', async () => {
    const graph: LoopGraph = {
      id: 'delegates', version: '1', entry: 'hand-off',
      budget: { maxRounds: 5 },
      nodes: [
        { kind: 'agent', id: 'hand-off', agent: 'research', as: 'research', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    };

    const acts = activities();
    const result = await runWorkflow(input(graph), acts);

    expect(result.outcome).toBe('ok');
    expect(acts.EngineResolveAgentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ agentSlug: 'research' }),
    );
    expect(acts.EngineModelCallActivity).toHaveBeenCalled();
  }, 60_000);

  it('fails the delegation readably when the named agent does not exist', async () => {
    const graph: LoopGraph = {
      id: 'delegates', version: '1', entry: 'hand-off',
      budget: { maxRounds: 5 },
      nodes: [
        { kind: 'agent', id: 'hand-off', agent: 'ghost', as: 'ghost', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    };

    const acts = activities({
      EngineResolveAgentActivity: vi.fn(async () => ({ found: false, callableAgents: [] })),
    });

    const result = await runWorkflow(input(graph), acts);

    expect(result.outcome).toBe('ok');
    expect(acts.EngineModelCallActivity).not.toHaveBeenCalled();
  }, 60_000);

  it('turns a model calling another agent by name into a child run, not a tool call', async () => {
    let round = 0;
    const acts = activities({
      EngineModelCallActivity: vi.fn(async () => {
        round += 1;
        return round === 1
          ? reply({ content: '', toolCalls: [{ id: 'a1', name: 'research', arguments: '{"question":"what broke?"}' }] })
          : reply();
      }),
    });

    const graph: LoopGraph = {
      id: 'chat', version: '1', entry: 'think',
      budget: { maxRounds: 5 },
      nodes: [
        { kind: 'model', id: 'think', tools: 'granted', next: [
          { to: 'work', when: 'not empty(reply.toolCalls)' },
          { to: 'done' },
        ] },
        { kind: 'dispatch', id: 'work', next: [{ to: 'think' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    };

    const result = await runWorkflow(input(graph, { callableAgents: ['research'] }), acts);

    expect(result.outcome).toBe('ok');
    expect(acts.EngineResolveAgentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ agentSlug: 'research' }),
    );
    expect(acts.EngineToolActivity).not.toHaveBeenCalled();
  }, 60_000);

  const machineGraph: LoopGraph = {
    id: 'does-work', version: '1', entry: 'think',
    budget: { maxRounds: 5 },
    nodes: [
      { kind: 'model', id: 'think', tools: 'granted', next: [
        { to: 'work', when: 'not empty(reply.toolCalls)' },
        { to: 'done' },
      ] },
      { kind: 'dispatch', id: 'work', next: [{ to: 'think' }] },
      { kind: 'terminal', id: 'done', outcome: 'ok' },
    ],
  };

  const wantsToRunSomething = () => {
    let round = 0;
    return vi.fn(async () => {
      round += 1;
      return round === 1
        ? reply({ content: '', toolCalls: [{ id: 'c1', name: 'run_command', arguments: '{"command":"rm -rf build"}' }] })
        : reply();
    });
  };

  const onMachine = () => vi.fn(async () => ({
    kind: 'machine' as const,
    deviceId: 'tallgeese',
    deviceName: 'Tallgeese',
    path: 'projects/thing',
  }));

  it('asks before running a command on your machine, and runs it once approved', async () => {
    const acts = activities({
      EngineResolveEnvironmentActivity: onMachine(),
      EngineModelCallActivity: wantsToRunSomething(),
    });

    const result = await runWorkflow(input(machineGraph), acts, async (handle) => {
      await handle.signal(approveSignal, { callId: 'c1', allowed: true });
    }, ['device-tallgeese']);

    expect(result.outcome).toBe('ok');
    expect(acts.EngineToolActivity).toHaveBeenCalledTimes(1);
    expect(acts.EnginePublishActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('Tallgeese') }),
        ]),
      }),
    );
  }, 60_000);

  it('never runs the command when you decline, and tells the model why', async () => {
    const acts = activities({
      EngineResolveEnvironmentActivity: onMachine(),
      EngineModelCallActivity: wantsToRunSomething(),
    });

    const result = await runWorkflow(input(machineGraph), acts, async (handle) => {
      await handle.signal(approveSignal, { callId: 'c1', allowed: false });
    });

    expect(result.outcome).toBe('ok');
    expect(acts.EngineToolActivity).not.toHaveBeenCalled();
  }, 60_000);

  it('does not ask at all when the work is in a sandbox', async () => {
    const acts = activities({ EngineModelCallActivity: wantsToRunSomething() });

    const result = await runWorkflow(input(machineGraph), acts);

    expect(result.outcome).toBe('ok');
    expect(acts.EngineToolActivity).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('resolves its sandbox once and names it on the tool call, rather than getting a new one each time', async () => {
    const acts = activities({ EngineModelCallActivity: wantsToRunSomething() });

    await runWorkflow(input(machineGraph), acts);

    expect(acts.EngineResolveEnvironmentActivity).toHaveBeenCalledTimes(1);
    expect(acts.EngineToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({ id: 'engine-sandbox-1' }),
      }),
    );
  }, 60_000);

  it('tears the sandbox down when the run finishes', async () => {
    const acts = activities();

    await runWorkflow(input(researchLoop), acts);

    expect(acts.EngineReleaseEnvironmentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'engine-sandbox-1' }),
    );
  }, 60_000);

  it('tears the sandbox down even when the run fails, so a crash does not leak a pod', async () => {
    const acts = activities({
      EngineModelCallActivity: vi.fn(async () => { throw new Error('the endpoint is down'); }),
    });

    await runWorkflow(input(researchLoop), acts).catch(() => undefined);

    expect(acts.EngineReleaseEnvironmentActivity).toHaveBeenCalled();
  }, 60_000);

  it('never asks for a sandbox teardown when the run was working on your machine', async () => {
    const acts = activities({ EngineResolveEnvironmentActivity: onMachine() });

    await runWorkflow(input(researchLoop), acts);

    expect(acts.EngineReleaseEnvironmentActivity).not.toHaveBeenCalled();
  }, 60_000);

  it('stops at the budget and says which limit it hit', async () => {
    const looping: LoopGraph = {
      id: 'loops', version: '1', entry: 'think',
      budget: { maxRounds: 2 },
      nodes: [
        { kind: 'model', id: 'think', tools: 'granted', next: [{ to: 'think' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    };

    const result = await runWorkflow(input(looping, { budget: { maxRounds: 2 } }), activities());

    expect(result.outcome).toBe('exhausted');
    expect(result.reason).toMatch(/all 2 rounds/);
  }, 60_000);
});
