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
import type { PlanProposal } from '../lib/plan-proposals.js';
import { createToolRuntime } from './tools/tool-runtime.js';
import type { RunTicket } from './temporal/contracts.js';

const planner = ALL_SEEDED_AGENTS().find((agent) => agent.slug === 'planner')!;

let trees: Tree[];
let branches: Branch[];
let leaves: Leaf[];
let tasks: Task[];

let plans: PlanProposal[];

const world = () => ({
  trees: { list: async () => trees, save: async (tree: Tree) => { trees.push(tree); } },
  branches: { list: async () => branches, save: async (branch: Branch) => { branches.push(branch); } },
  leaves: { list: async () => leaves, save: async (leaf: Leaf) => { leaves.push(leaf); } },
  plans: {
    save: async (proposal: PlanProposal) => { plans = [...plans.filter((entry) => entry.id !== proposal.id), proposal]; },
    list: async (ownerId: string, conversationId?: string) =>
      plans.filter((entry) => entry.ownerId === ownerId && (conversationId === undefined || entry.conversationId === conversationId)),
  },
  treeTypes: async () => [{ id: 'application', label: 'Application', summary: 'A running app' }],
});

const taskStore = {
  list: async (ownerId: string): Promise<Task[]> => tasks.filter((task) => task.ownerId === ownerId),
  save: async (task: Task): Promise<void> => {
    const index = tasks.findIndex((candidate) => candidate.id === task.id);
    if (index >= 0) tasks[index] = task;
    else tasks.push(task);
  },
};

const PLAN = {
  treeId: 'tree-1',
  planDoc: '# The job queue\n\nGoal: async work rides on one queue. Assumption: Redis is available.',
  branches: [{
    title: 'A deployment lane',
    leaves: [{
      key: 'queue',
      title: 'The job queue',
      body: 'A worker pool picks jobs up within a second; failures retry three times.',
      brief: 'Use the existing Redis; the worker lives in src/worker.ts.',
      tasks: [{
        key: 'wire',
        title: 'Wire the queue',
        doneMeans: 'jobs are picked up within a second of enqueue',
        description: 'Add the worker pool, the retry loop, and the startup drain.',
        role: 'Every async piece of the plan — webhooks, the nightly report — rides on this queue.',
      }],
    }],
  }],
};

function scriptedModel() {
  let round = 0;

  const call = (id: string, name: string, args: unknown) => ({
    choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
  });

  const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => {
    round += 1;

    let payload: unknown;
    if (round === 1) payload = call('c1', 'make_branch', { treeId: 'tree-1', title: 'A deployment lane' });
    else if (round === 2) {
      const unbriefed = structuredClone(PLAN) as { branches: { leaves: { brief?: string }[] }[] };
      delete unbriefed.branches[0]!.leaves[0]!.brief;
      payload = call('c2', 'propose_plan', unbriefed);
    } else if (round === 3) payload = call('c3', 'propose_plan', PLAN);
    else if (round === 4) payload = call('c4', 'propose_plan', { ...PLAN, planDoc: `${PLAN.planDoc}\n\nRevised: the retry count is three.` });
    else payload = { choices: [{ delta: { content: 'Proposed one branch, one leaf, one briefed task — waiting for your approval.' }, finish_reason: 'stop' }] };

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
    tools: createToolRuntime({ registry, handlers }),
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
  plans = [];
}

describe('the seeded planner, end to end against real stores', () => {
  let fetchImpl: ReturnType<typeof scriptedModel>;

  beforeEach(setupWorld);
  afterEach(() => vi.unstubAllGlobals());

  it('proposes the whole plan for approval and creates nothing in the grove, through the real tool gate', async () => {
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
      launch: { ownerId: ticket.ownerId, conversationId: 'conv-1' },
      inputs: { treeId: 'tree-1', goal: 'Ship the job queue under the deployment lane.' },
    });
    expect(result.outcome).toBe('ok');

    const seen = fetchImpl.mock.calls.map(([, init]) => String((init as RequestInit).body)).join('\n');
    expect(seen).toContain('\\"make_branch\\" is not a tool this agent can use');
    expect(seen).toContain('needs a brief');

    expect(branches).toEqual([]);
    expect(leaves).toEqual([]);
    expect(tasks).toEqual([]);

    expect(plans.map((entry) => entry.status).sort()).toEqual(['proposed', 'superseded']);
    const open = plans.filter((entry) => entry.status === 'proposed');
    expect(open[0]!.plan.planDoc).toContain('Revised');
    expect(plans[0]).toMatchObject({
      ownerId: 'user-1',
      conversationId: 'conv-1',
      runId: 'run-grove-1',
      plan: { treeId: 'tree-1', branches: [{ title: 'A deployment lane', leaves: [{ key: 'queue', tasks: [{ key: 'wire' }] }] }] },
    });
    expect(open[0]!.plan.branches[0]!.leaves[0]!.brief).toContain('src/worker.ts');
  });
});