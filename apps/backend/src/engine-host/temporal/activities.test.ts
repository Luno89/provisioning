import { describe, it, expect, vi } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { stepImplementation } from '@koala/agent-engine/procedure';
import { createEngineActivities, createNodeRunner, NODE_HEARTBEAT_MS, type EngineServices } from './activities.js';
import type { Task } from '../tools/tasks.js';
import { createEventBus, type EngineEvent } from '@koala/agent-engine';
import { createAgentRegistry } from '../registries/registry.js';
import type { RunTicket } from './contracts.js';

const ticket = (over: Partial<RunTicket> = {}): RunTicket => ({
  runId: 'run-1',
  depth: 0,
  ownerId: 'user-1',
  agentSlug: 'koala',
  trigger: 'user',
  ...over,
});

function services(over: Partial<EngineServices> = {}): { services: EngineServices; events: EngineEvent[] } {
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((event) => events.push(event));

  return {
    events,
    services: {
      registry: createAgentRegistry(),
      endpoints: {
        forAgent: vi.fn(async () => ({
          endpoint: {
            baseUrl: 'https://models.test/v1',
            apiKey: 'k',
            model: 'test-model',
            rateLimitKey: `bucket-${Math.random()}`,
            ownerId: 'user-1',
            label: 'Test',
          },
          maxTokens: 500,
        })),
      },
      environments: {
        describe: vi.fn(async () => sandboxEnvironment()),
        forRun: vi.fn(async () => undefined),
        release: vi.fn(async () => undefined),
      },
      tools: { run: vi.fn(async () => ({ ok: true, digest: 'tool digest', content: 'tool content' })) },
      merges: { run: vi.fn(async () => ({ merged: 2 })) },
      bus,
      ...over,
    },
  };
}

const sandboxEnvironment = () => ({
  kind: 'sandbox' as const,
  id: 'engine-run-1',
  capabilities: { kind: 'sandbox' as const, lifecycle: 'invocation' as const },
  workspace: {
    runId: 'run-1',
    ownerId: 'user-1',
    agent: 'koala',
    image: 'registry.access.redhat.com/ubi9/nodejs-22',
    provides: ['bash', 'git', 'node', 'npm'],
    egressMode: 'declared' as const,
    lifetimeMs: 30 * 60_000,
    cpu: '2',
    memory: '2Gi',
    env: [],
    egress: [],
  },
});

describe('the remaining engine activities', () => {
  it('delegates tool calls to the tool runtime', async () => {
    const { services: svc } = services();
    const activities = createEngineActivities(svc);

    const outcome = await activities.EngineToolActivity({
      ticket: ticket(),
      nodeId: 'work',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    });

    expect(outcome).toMatchObject({ ok: true, digest: 'tool digest' });
    expect(svc.tools.run).toHaveBeenCalledWith(expect.objectContaining({ name: 'read_file' }));
  });

  it('delegates a custom merge strategy to its runtime', async () => {
    const { services: svc } = services();
    const activities = createEngineActivities(svc);

    expect(await activities.EngineMergeActivity({
      ticket: ticket(), nodeId: 'join', strategy: 'conflict-resolver', children: [],
    })).toEqual({ merged: 2 });
  });

  it('resolves and releases the run environment through the resolver, keyed by the run', async () => {
    const { services: svc } = services();
    const activities = createEngineActivities(svc);

    expect(await activities.EngineResolveEnvironmentActivity({ ticket: ticket() }))
      .toMatchObject({ kind: 'sandbox', id: 'engine-run-1' });

    await activities.EngineReleaseEnvironmentActivity({ ticket: ticket(), environmentId: 'engine-run-1' });

    expect(svc.environments.release).toHaveBeenCalledWith('run-1');
  });

  it('publishes workflow-side events onto the bus', async () => {
    const { services: svc, events } = services();
    const activities = createEngineActivities(svc);

    await activities.EnginePublishActivity({
      events: [
        { type: 'run.started', runId: 'run-1', at: 'now', agentId: 'koala', loopId: 'interactive-chat' },
        { type: 'notice', runId: 'run-1', at: 'now', level: 'info', message: 'waiting on you' },
      ],
    });

    expect(events.map((e) => e.type)).toEqual(['run.started', 'notice']);
  });
});

describe('running a node as an activity', () => {
  it('keeps telling Temporal it is alive while a node runs, so a worker that dies is noticed in a minute rather than half an hour', async () => {
    vi.useFakeTimers();
    try {
      let finish: () => void = () => undefined;
      const slow = stepImplementation('call-model', () => new Promise((resolve) => { finish = () => resolve({ exit: 'answered' }); }));
      const runner = createNodeRunner([slow], undefined);
      const env = new MockActivityEnvironment();
      const beats: unknown[] = [];
      env.on('heartbeat', (detail: unknown) => beats.push(detail));

      const running = env.run(runner, {
        node: { id: 'call', kind: 'call-model', settings: {}, position: { x: 0, y: 0 } },
        origin: 'call',
        inputs: {},
        execution: 1,
        run: {
          identity: { runId: 'run-1', depth: 0, agentId: 'koala', loopId: 'x', loopVersion: '1', trigger: 'user' },
          launch: { ownerId: 'user-1' },
          inputs: {},
          counters: { rounds: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCalls: 0, childRuns: 0, startedAt: 0, elapsedMs: 0 },
          budget: {},
          cleaningUp: false,
        },
      } as never);
      await vi.advanceTimersByTimeAsync(NODE_HEARTBEAT_MS * 3 + 1);
      finish();
      await running;
      const afterFinishing = beats.length;
      await vi.advanceTimersByTimeAsync(NODE_HEARTBEAT_MS * 3);

      expect(afterFinishing).toBe(3);
      expect(beats).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('settling the tasks a run claimed', () => {
  const task = (over: Partial<Task>): Task => ({
    id: 't', ownerId: 'user-1', title: 'Write hello.txt', doneMeans: 'it exists', dependsOn: [], status: 'running',
    runs: ['run-1'], createdAt: 'then', updatedAt: 'then', ...over,
  });

  it('marks a task the run left running as failed, saying how the run ended, and leaves everything else alone', async () => {
    const stored = [
      task({ id: 'left-running' }),
      task({ id: 'recorded', status: 'done' }),
      task({ id: 'someone-elses', runs: ['run-1', 'run-2'] }),
    ];
    const saved: Task[] = [];
    const { services: svc } = services({ tasks: { list: async () => stored, save: async (updated) => { saved.push(updated); } } });

    const settled = await createEngineActivities(svc).EngineSettleClaimsActivity({ ownerId: 'user-1', runId: 'run-1', outcome: 'failed', reason: '"turn" failed: the endpoint is down' });

    expect(settled).toEqual(['left-running']);
    expect(saved).toEqual([expect.objectContaining({
      id: 'left-running',
      status: 'failed',
      evidence: 'the run working on it ended without recording an outcome: failed — "turn" failed: the endpoint is down',
    })]);
  });
});

