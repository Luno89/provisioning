import { anyOf, matching, objectWith } from '../../platform/lib/test-matchers.js';
import { describe, it, expect, vi } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { stepImplementation } from '@koala/agent-engine/procedure';
import { CANCEL_POLL_MS, createEngineActivities, createNodeRunner, createStreamActivities, NODE_HEARTBEAT_MS, type EngineServices } from './activities.js';
import type { Task } from '../tools/tasks.js';
import { createEventBus, type EngineEvent } from '@koala/agent-engine';
import { createAgentRegistry } from '../registries/registry.js';
import type { RunTicket } from './contracts.js';
import { grantHeld, grantsHeldInMemory } from '../../engine/testing/run-grants.js';
import { asPerson } from '../../platform/lib/permissions.js';

const ticket = (over: Partial<RunTicket> = {}): RunTicket => ({
  runId: 'run-1',
  depth: 0,
  ownerId: 'user-1',
  grantId: 'grant-1',
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
        describeShared: vi.fn(async () => sandboxEnvironment()),
        composeShared: vi.fn(async () => { throw new Error('composing is not used here'); }),
        forRun: vi.fn(async () => undefined),
        release: vi.fn(async () => undefined),
      },
      tools: { run: vi.fn(async () => ({ ok: true, digest: 'tool digest', content: 'tool content' })) },
      merges: { run: vi.fn(async () => ({ merged: 2 })) },
      grants: grantsHeldInMemory(),
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
    expect(svc.tools.run).toHaveBeenCalledWith(objectWith({ name: 'read_file' }), 1, anyOf(AbortSignal));
  });

  it('keeps a long tool call alive with heartbeats, and hands it the stop when the run is stopped', async () => {
    const { services: svc } = services();
    let seen: AbortSignal | undefined;
    svc.tools.run = vi.fn(async (_args, _attempt, signal?: AbortSignal) => {
      seen = signal;
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { ok: false, digest: 'stopped' };
    }) as never;
    const env = new MockActivityEnvironment();
    const beats: unknown[] = [];
    env.on('heartbeat', (detail: unknown) => beats.push(detail));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const running = env.run(createEngineActivities(svc).EngineToolActivity, { ticket: ticket(), nodeId: 'work', name: 'run_command', arguments: '{"command":"sleep 600"}' });
      vi.advanceTimersByTime(NODE_HEARTBEAT_MS * 3);
      expect(beats.length).toBeGreaterThanOrEqual(3);
      env.cancel();
      expect(await running).toEqual({ ok: false, digest: 'stopped' });
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hears that the run was stopped even when nothing cancels the call itself', async () => {
    const { services: svc } = services();
    svc.runCancelled = vi.fn(async () => true);
    svc.tools.run = vi.fn(async (_args, _attempt, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { ok: false, digest: 'stopped' };
    }) as never;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const running = createEngineActivities(svc).EngineToolActivity({ ticket: ticket(), nodeId: 'work', name: 'run_command', arguments: '{"command":"sleep 600"}' });
      vi.advanceTimersByTime(CANCEL_POLL_MS);
      expect(await running).toEqual({ ok: false, digest: 'stopped' });
      expect(svc.runCancelled).toHaveBeenCalledWith('run-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands a call started after its run was stopped the stop at once, and still answers with what it returned', async () => {
    const { services: svc } = services();
    let seen: AbortSignal | undefined;
    svc.tools.run = vi.fn(async (_args, _attempt, signal?: AbortSignal) => {
      seen = signal;
      return { ok: true, digest: 'cleaned up' };
    }) as never;
    const outcome = await createEngineActivities(svc).EngineToolActivity({ ticket: ticket(), nodeId: 'work', name: 'run_command', arguments: '{}', hearsStops: true, stoppedBecause: 'the run was cancelled' });
    expect(outcome).toEqual({ ok: true, digest: 'cleaned up' });
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe('the run was cancelled');
  });

  it('never asks a run that hears its stops through cancellation whether it was stopped', async () => {
    const { services: svc } = services();
    svc.runCancelled = vi.fn(async () => true);
    svc.tools.run = vi.fn(async () => ({ ok: true, digest: 'done' })) as never;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const running = createEngineActivities(svc).EngineToolActivity({ ticket: ticket(), nodeId: 'work', name: 'read_file', arguments: '{}', hearsStops: true });
      vi.advanceTimersByTime(CANCEL_POLL_MS * 3);
      expect(await running).toEqual({ ok: true, digest: 'done' });
      expect(svc.runCancelled).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  it('hands a notice meant for people to whoever posts it, with the run\'s owner, and nothing else', async () => {
    const { services: svc } = services();
    const posted: unknown[] = [];
    const activities = createEngineActivities({ ...svc, post: async (ownerId, notice) => { posted.push({ ownerId, notice }); } });

    await activities.EnginePublishActivity({
      ownerId: 'user-1',
      events: [
        { type: 'notice', runId: 'run-1', at: 'now', level: 'info', message: 'ready', post: { key: 'k', kind: 'workspace-ready' } },
        { type: 'notice', runId: 'run-1', at: 'now', level: 'info', message: 'just a note' },
      ] as never,
    });

    expect(posted).toEqual([{ ownerId: 'user-1', notice: { key: 'k', kind: 'workspace-ready' } }]);
  });

  it('tells the run\'s owner when a run asks before a call, naming only the tool', async () => {
    const { services: svc } = services();
    const asked: Array<{ ownerId: string; tool: string }> = [];
    const activities = createEngineActivities({ ...svc, asking: async (ownerId, tool) => { asked.push({ ownerId, tool }); } });

    await activities.EnginePublishActivity({
      ownerId: 'user-1',
      events: [
        { type: 'notice', runId: 'run-1', at: 'now', level: 'warn', nodeId: 'approve', callId: 'c1', tool: 'delete_file', message: 'koala wants to run delete_file on this run: {"path":"secret.txt"}' },
        { type: 'notice', runId: 'run-1', at: 'now', level: 'info', message: 'just a note' },
      ] as never,
    });
    await activities.EnginePublishActivity({
      events: [{ type: 'notice', runId: 'run-2', at: 'now', level: 'warn', callId: 'c2', tool: 'run_command', message: 'no owner' }] as never,
    });

    expect(asked).toEqual([{ ownerId: 'user-1', tool: 'delete_file' }]);
  });

  it('hands where a project\'s deletion stands to whoever tells its owner, and refuses without retrying when nothing here does', async () => {
    const { services: svc } = services();
    const changes: unknown[] = [];
    const change = { ownerId: 'user-1', projectId: 'p1', progress: { seq: 1, phase: 'deleting' as const, work: [], parts: {} } };
    await createStreamActivities({ ...svc, deletionChanged: async (told) => { changes.push(told); } }).ProjectDeletionChangedActivity(change);
    expect(changes).toEqual([change]);
    await expect(createStreamActivities(svc).ProjectDeletionChangedActivity(change)).rejects.toMatchObject({ nonRetryable: true });
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
          launch: { ownerId: 'user-1', grantId: 'grant-1' },
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
    expect(saved).toEqual([objectWith({
      id: 'left-running',
      status: 'failed',
      evidence: 'the run working on it ended without recording an outcome: failed — "turn" failed: the endpoint is down',
    })]);
  });
});


describe('a run handing work to another agent', () => {
  const persona = (slug: string, agents: string[] = []) => ({ slug, name: slug, description: slug, version: '1', prompt: 'p', procedure: 'tool-rounds', guidance: '', returns: '', failures: [], tools: [], environment: {}, agents });

  it('resolves the agent only when the run handing it work holds that hand-off and its grant is live', async () => {
    const grants = grantsHeldInMemory();
    const from = ticket({ agentSlug: 'asker', grantId: await grantHeld(grants) });
    const registry = createAgentRegistry({ agentStore: { list: async () => [persona('asker', ['helper']), persona('helper'), persona('other')] }, toolCatalogue: { list: async () => [] } });
    const activities = createEngineActivities(services({ registry, grants }).services);
    expect(await activities.EngineResolveAgentActivity({ ownerId: 'user-1', agentSlug: 'helper', handedBy: from })).toMatchObject({ found: true });
    expect(await activities.EngineResolveAgentActivity({ ownerId: 'user-1', agentSlug: 'other', handedBy: from }))
      .toEqual({ found: false, refused: 'asker is not allowed to hand work to "other" — grant it the agent first', callableAgents: [] });
  });
});

describe('the run a tree is grown by', () => {
  const tree = { id: 'tree-1', ownerId: 'user-1', name: 'Paper', type: 'research-paper', projectIds: [], createdAt: 'then', updatedAt: 'then' };
  const grants = grantsHeldInMemory();
  const grantFor = async (ownerId: string, runId: string) => (await grants.issueOnce({ ownerId, runId, principal: asPerson(ownerId), startedBy: 'person' })).id;
  const neverStarted = (runId: string) => grants.neverStarted(runId);
  const grove = (types: { id: string; label: string; summary: string; agent?: string; ownerId?: string }[], over: Partial<EngineServices> = { grantFor, neverStarted }) => services({
    ...over,
    grove: {
      trees: { list: async () => [tree] as never },
      branches: { list: async () => [] },
      leaves: { list: async () => [] },
      tasks: { list: async () => [] },
      treeTypes: async () => types,
    },
  }).services;

  it('starts the agent the tree\'s type names, on that agent\'s procedure, keyed to the tree', async () => {
    const activities = createEngineActivities(grove([{ id: 'research-paper', label: 'Paper', summary: 's', agent: 'grove-paper' }]));

    const input = await activities.GroveRunInputActivity({ treeId: 'tree-1', ownerId: 'user-1' });

    expect(input.ticket).toMatchObject({ runId: matching(/^grove-run-tree-1~[0-9a-z]+$/), agentSlug: 'grove-paper', ownerId: 'user-1' });
    expect(input.procedure.id).toBe('grove-paper-run');
    expect(input.inputs).toMatchObject({ treeId: 'tree-1' });
    expect(await grants.grant(input.ticket.grantId)).toMatchObject({ runId: input.ticket.runId, personId: 'user-1', startedBy: 'person', state: 'live' });
  });

  it('starts the same run with the same grant when the start is tried again, and ends that grant when the run never started', async () => {
    const activities = createEngineActivities(grove([{ id: 'research-paper', label: 'Paper', summary: 's' }]));
    const first = await activities.GroveRunInputActivity({ treeId: 'tree-1', ownerId: 'user-1', at: 1_700_000_000_000 });
    const again = await activities.GroveRunInputActivity({ treeId: 'tree-1', ownerId: 'user-1', at: 1_700_000_000_000 });
    expect(again.ticket).toMatchObject({ runId: first.ticket.runId, grantId: first.ticket.grantId });

    await activities.GroveRunNeverStartedActivity({ runId: first.ticket.runId });
    expect(await grants.grant(first.ticket.grantId)).toMatchObject({ state: 'ended' });
  });

  it('refuses, without retrying, to grow a tree where no run grant can be issued', async () => {
    const ungranted = createEngineActivities(grove([{ id: 'research-paper', label: 'Paper', summary: 's' }], {}));
    await expect(ungranted.GroveRunInputActivity({ treeId: 'tree-1', ownerId: 'user-1' })).rejects.toThrow(/issues no run grants, so it cannot grow a tree/);
  });

  it('starts the grove agent when the type names none', async () => {
    const activities = createEngineActivities(grove([{ id: 'research-paper', label: 'Paper', summary: 's' }]));
    expect((await activities.GroveRunInputActivity({ treeId: 'tree-1', ownerId: 'user-1' })).procedure.id).toBe('grove-run');
  });

  it('refuses, without retrying, a tree that is not there or an agent that does not exist', async () => {
    const missing = createEngineActivities(grove([{ id: 'research-paper', label: 'Paper', summary: 's', agent: 'ghost' }]));
    await expect(missing.GroveRunInputActivity({ treeId: 'tree-1', ownerId: 'user-1' })).rejects.toThrow(/no agent called "ghost"/);
    await expect(missing.GroveRunInputActivity({ treeId: 'nope', ownerId: 'user-1' })).rejects.toThrow(/no tree "nope"/);
  });
});

describe('concluding a workspace', () => {
  const saved = { saved: true as const, owner: 'koala-user-1', repo: 'x', commit: 'c0ffee' };

  it('releases a tree\'s workspace, and concludes a conversation\'s for the agent it is held with', async () => {
    const release = vi.fn(async () => saved);
    const conclude = vi.fn(async () => saved);
    const { services: svc } = services({
      treeWorkspaces: { release } as never,
      conversationWorkspaces: { conclude },
      conversationAgent: async (_ownerId, id) => (id === 'c1' ? 'delivery' : undefined),
    });
    const activities = createEngineActivities(svc);

    expect(await activities.ConcludeWorkspaceActivity({ ownerId: 'user-1', workspace: { kind: 'tree', id: 't1' } })).toEqual(saved);
    await activities.ConcludeWorkspaceActivity({ ownerId: 'user-1', workspace: { kind: 'conversation', id: 'c1' } });
    await activities.ConcludeWorkspaceActivity({ ownerId: 'user-1', workspace: { kind: 'conversation', id: 'gone' } });

    expect(release).toHaveBeenCalledWith('t1', 'user-1');
    expect(conclude.mock.calls).toEqual([
      [{ conversationId: 'c1', ownerId: 'user-1', agentSlug: 'delivery' }],
      [{ conversationId: 'gone', ownerId: 'user-1', agentSlug: 'koala' }],
    ]);
  });

  it('fails, so Temporal retries it, when the save does not work', async () => {
    const { services: svc } = services({ treeWorkspaces: { release: async () => { throw new Error('Gitea is down'); } } as never });

    await expect(createEngineActivities(svc).ConcludeWorkspaceActivity({ ownerId: 'user-1', workspace: { kind: 'tree', id: 't1' } })).rejects.toThrow('Gitea is down');
  });
});

describe('publishing a run\'s events', () => {
  it('stamps each with the run\'s owner, so only that person\'s browsers receive it', async () => {
    const { services: svc, events } = services();
    const event = { type: 'tool.called', runId: 'run-1', at: 'now', nodeId: 'tools', callId: 'a', name: 'read_file', args: '{}' } as EngineEvent;

    await createEngineActivities(svc).EnginePublishActivity({ ownerId: 'user-1', events: [event] });

    expect(events).toEqual([{ ...event, ownerId: 'user-1' }]);
  });
});

describe('sending a workspace\'s work to a machine', () => {
  it('starts the run\'s workspace before it bundles the folder, so a conversation workspace nothing has run in yet still goes', async () => {
    const { createMachineWork } = await import('../sandboxes/machine-work.js');
    let running = false;
    const exec = vi.fn(async () => { running = true; return { exitCode: 0, stdout: '', stderr: '' }; });
    const forRun = vi.fn(async () => ({ exec }) as never);
    const sendBranch = vi.fn(async () => {
      if (!running) throw new Error('the workspace is not running');
      return { commit: 'c0ffee' };
    });
    const machineWork = createMachineWork({
      documents: { sendBranch } as never,
      repoFor: async () => ({ repo: 'conversation-c1', path: '/work', describe: 'this conversation\'s documents' }),
    });
    const base = services();
    const activities = createEngineActivities({ ...base.services, environments: { ...base.services.environments, forRun }, machineWork });
    const environment = { id: 'engine-conversation-c1', spec: { kind: 'sandbox' as const, lifecycle: 'persistent' as const } };

    const sent = await activities.EngineMachineSendActivity({
      ownerId: 'user-1', workspaceRunId: 'conversation-c1', branch: 'machine/d/k', message: 'Work so far',
      start: { ticket: ticket({ runId: 'run-1-research-1' }), environment },
    });

    expect(forRun).toHaveBeenCalledWith({ ticket: ticket({ runId: 'run-1-research-1' }), environment });
    expect(exec).toHaveBeenCalledWith({ command: 'true' });
    expect(sendBranch).toHaveBeenCalledWith(objectWith({ repo: 'conversation-c1', folder: '/work', branch: 'machine/d/k' }));
    expect(sent).toEqual({ repo: 'conversation-c1', folder: '/work', commit: 'c0ffee' });
  });
});

describe('recording a machine\'s cluster as the workflows start and stop it', () => {
  const records = () => ({ started: vi.fn(async () => undefined), stopped: vi.fn(async () => undefined), idle: vi.fn(async () => true) });
  const streamWith = (machineClusters?: ReturnType<typeof records>) => createStreamActivities({ registry: {} as never, endpoints: {} as never, bus: createEventBus(), machineClusters });

  it('hands each step to the cluster records', async () => {
    const clusters = records();
    const activities = streamWith(clusters);
    const result = { state: 'running' as const, meshIp: '100.64.0.7', kubeconfig: 'k' };
    await activities.EngineMachineClusterStartedActivity({ clusterId: 'machine-desk', result });
    await activities.EngineMachineClusterStoppedActivity({ clusterId: 'machine-desk' });
    expect(await activities.EngineMachineClusterIdleActivity({ clusterId: 'machine-desk', leaving: 'shop' })).toBe(true);
    expect(clusters.started).toHaveBeenCalledWith('machine-desk', result);
    expect(clusters.stopped).toHaveBeenCalledWith('machine-desk');
    expect(clusters.idle).toHaveBeenCalledWith('machine-desk', 'shop');
  });

  it('fails for good where this Koala keeps no machine clusters', async () => {
    await expect(streamWith().EngineMachineClusterIdleActivity({ clusterId: 'machine-desk' })).rejects.toThrow('keeps no machine clusters');
  });
});
