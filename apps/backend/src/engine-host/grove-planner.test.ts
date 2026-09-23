import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  BUILT_IN_GROUPS,
  PLANNING_V2,
  builtInCatalogue,
  runProcedure,
} from '@koala/agent-engine/procedure';
import { ALL_SEEDED_AGENTS } from '@koala/agent-engine';
import type { ToolContract } from '@koala/engine-core';
import { createAgentRegistry } from './registries/registry.js';
import { createEnvironmentResolver } from './sandboxes/environments.js';
import { createRunEnvironments } from './sandboxes/run-environments.js';
import { createProcedureExecutor, type HostNodeServices } from './nodes/index.js';
import { inMemoryConversations } from './nodes/conversation-nodes.js';
import { createTaskTools } from './tools/task-tools.js';
import { createGroveTools } from './tools/grove-tools.js';
import { GROVE_TOOLS } from './tools/grove-tools-catalogue.js';
import { TASK_TOOLS } from './tools/task-tools-catalogue.js';
import type { Task } from './tools/tasks.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';
import type { RunTicket } from './temporal/contracts.js';

const planner = ALL_SEEDED_AGENTS().find((agent) => agent.slug === 'planner')!;

let trees: Tree[];
let branches: Branch[];
let leaves: Leaf[];
let tasks: Task[];

const world = () => ({
  trees: { list: async () => trees, save: async (tree: Tree) => { trees.push(tree); } },
  branches: { list: async () => branches, save: async (branch: Branch) => { branches.push(branch); } },
  leaves: { list: async () => leaves, save: async (leaf: Leaf) => { leaves.push(leaf); } },
});

const taskStore = {
  list: async (ownerId: string): Promise<Task[]> => tasks.filter((task) => task.ownerId === ownerId),
  save: async (task: Task): Promise<void> => {
    const index = tasks.findIndex((candidate) => candidate.id === task.id);
    if (index >= 0) tasks[index] = task;
    else tasks.push(task);
  },
};

/**
 * A scripted model that works a Grove plan: branch, leaf, one briefed task, done.
 * It reacts to the observations the tools node records — each branch and leaf id
 * in its next call comes from the previous round's result, as a real model would.
 */
function scriptedModel() {
  let round = 0;

  const bodyOf = (init: RequestInit): { content: string }[] => {
    const sent = JSON.parse((init.body as string) ?? '{}') as { messages?: { role: string; content?: string }[] };
    return (sent.messages ?? []).map((message) => ({ content: typeof message.content === 'string' ? message.content : '' }));
  };

  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    round += 1;
    const seen = bodyOf(init).map((message) => message.content).join('\n');
    const branch = /branched (\S+)/.exec(seen)?.[1];
    const leaf = /grown (\S+)/.exec(seen)?.[1];

    let payload: string;
    if (round === 1) {
      payload = {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'make_branch', arguments: JSON.stringify({ treeId: 'tree-1', title: 'A deployment lane' }) } }] }, finish_reason: null }]
      } as never;
    } else if (round === 2) {
      payload = {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'make_leaf', arguments: JSON.stringify({ branchId: branch, title: 'The job queue', body: 'A worker pool picks jobs up within a second; failures retry three times.' }) } }] }, finish_reason: null }]
      } as never;
    } else if (round === 3) {
      payload = {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c3', function: { name: 'propose_work', arguments: JSON.stringify({
          leafId: leaf,
          title: 'Wire the queue',
          doneMeans: 'jobs are picked up within a second of enqueue',
          description: 'Add the worker pool, the retry loop, and the startup drain.',
          role: 'Every async piece of the plan — webhooks, the nightly report — rides on this queue.',
        }) } }] }, finish_reason: null }]
      } as never;
    } else {
      payload = { choices: [{ delta: { content: 'Planned: one branch, one leaf, one briefed task.' }, finish_reason: 'stop' }] } as never;
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      body: (async function* () {
        yield `data: ${JSON.stringify(payload)}\n\n`;
      })(),
    } as unknown as Response;
  });

  return fetchImpl;
}

function engine() {
  const handlers = {
    ...createTaskTools({ store: taskStore }),
    ...createGroveTools({ stores: world() }),
  };

  const registry = createAgentRegistry({
    agentStore: { list: async () => [planner] },
    toolCatalogue: { list: async () => [...GROVE_TOOLS, ...TASK_TOOLS] as unknown as ToolContract[] },
  });

  const environments = createEnvironmentResolver({
    registry,
    environments: createRunEnvironments({ provision: async () => { throw new Error('the planner needs no sandbox'); } }),
    images: {
      ensure: async (plan) => plan.base,
      exists: async () => true,
      start: async (plan) => ({ state: 'ready' as const, reference: plan.base }),
      standing: async (plan) => ({ state: 'ready' as const, reference: plan.base }),
    },
    tools: async () => [],
  });

  const services: HostNodeServices = {
    conversations: inMemoryConversations(),
    registry,
    environments,
    models: {
      resolveBaseUrl: async () => ({
        provider: { id: 'bucket-1', name: 'Test', source: 'deployment', model: 'test-model', contextTokens: 32_000 } as never,
        baseUrl: 'https://models.test/v1',
        apiKey: 'k',
      }),
    },
    tools: {
      run: async (args) => {
        const handler = handlers[args.name];
        if (!handler) return { ok: false, digest: `no handler for ${args.name}` };

        const parsed = JSON.parse(args.arguments || '{}') as Record<string, unknown>;
        const outcome = await handler({
          name: args.name,
          parsed,
          driver: undefined,
          caller: {
            ownerId: args.ticket.ownerId,
            runId: args.ticket.runId,
            agentSlug: args.ticket.agentSlug,
            projectId: 'project-9',
          },
        });
        return {
          ok: outcome.ok,
          digest: outcome.digest,
          ...(outcome.content !== undefined && { content: outcome.content }),
          ...(outcome.declined && { declined: true }),
        };
      },
    },
    memories: { list: async () => [], save: async () => undefined },
  };

  return { services, registry };
}

const ticket: RunTicket = {
  runId: 'run-grove-1',
  depth: 0,
  ownerId: 'user-1',
  agentSlug: 'planner',
  trigger: 'user',
};

function setupWorld(): void {
  trees = [
    { id: 'tree-1', ownerId: 'user-1', name: 'The app', type: 'application', goal: 'Ship the job queue.', projectIds: ['project-9'], createdAt: 'now', updatedAt: 'now' },
  ];
  branches = [];
  leaves = [];
  tasks = [];
}

describe('the seeded planner, end to end against real stores', () => {
  let fetchImpl: ReturnType<typeof scriptedModel>;

  beforeEach(setupWorld);
  afterEach(() => vi.unstubAllGlobals());

  it('plans a tree into branch, leaf and one briefed task, each round working from the last', async () => {
    const { services, registry } = engine();
    fetchImpl = scriptedModel();
    vi.stubGlobal('fetch', fetchImpl);

    const result = await runProcedure({
      procedure: PLANNING_V2,
      catalogue: builtInCatalogue(),
      groups: BUILT_IN_GROUPS,
      executor: createProcedureExecutor(services, { registry }),
      identity: {
        runId: ticket.runId,
        depth: ticket.depth,
        agentId: ticket.agentSlug,
        loopId: PLANNING_V2.id,
        loopVersion: PLANNING_V2.version,
        trigger: 'user',
      },
      launch: { ownerId: ticket.ownerId },
      inputs: { treeId: 'tree-1', goal: 'Ship the job queue under the deployment lane.' },
    });
    expect(result.outcome).toBe('ok');
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(4);

    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({
      treeId: 'tree-1',
      title: 'A deployment lane',
      projectId: 'project-9',
      ownerId: 'user-1',
    });

    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatchObject({
      branchId: branches[0]!.id,
      title: 'The job queue',
      column: 'todo',
      status: 'proposed',
      blocking: false,
    });
    expect(leaves[0]?.body).toContain('within a second');

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      leafId: leaves[0]!.id,
      title: 'Wire the queue',
      status: 'proposed',
      ownerId: 'user-1',
      projectId: 'project-9',
    });
    expect(tasks[0]?.description).toContain('worker pool');
    expect(tasks[0]?.role).toContain('webhooks');
  });
});