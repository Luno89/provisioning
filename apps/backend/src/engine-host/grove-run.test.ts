import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BUILT_IN_GROUPS,
  GROVE_WORK_PASS,
  GROVE_JUDGE_PASS,
  builtInCatalogue,
  runProcedure,
} from '@koala/agent-engine/procedure';
import { ALL_SEEDED_AGENTS } from '@koala/agent-engine';
import type { ToolContract, ToolHandler } from '@koala/engine-core';
import { createAgentRegistry } from './registries/registry.js';
import { createEnvironmentResolver } from './sandboxes/environments.js';
import { createRunEnvironments } from './sandboxes/run-environments.js';
import { createProcedureExecutor, type HostNodeServices } from './nodes/index.js';
import { inMemoryConversations } from './nodes/conversation-nodes.js';
import { createSandboxDriver } from './drivers/sandbox.js';
import { createTaskTools } from './tools/task-tools.js';
import { createGroveTools } from './tools/grove-tools.js';
import { GROVE_TOOLS } from './tools/grove-tools-catalogue.js';
import { TASK_TOOLS } from './tools/task-tools-catalogue.js';
import type { Task } from './tools/tasks.js';
import type { AgentRegistry } from './registries/registry.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';
import type { RunTicket } from './temporal/contracts.js';

/**
 * The grove run, proven in-process: an activity-style loop drives the two seeded
 * pass procedures against real stores and a scripted model.
 *
 * The world: alpha and beta are independent leaves, each with one task; gamma
 * waits on both through dependsOn, so it cannot become ready until a judge has
 * settled alpha and beta.
 *
 * What this test pins, per the pass rule:
 *  - the pass-1 work run fans both independent leaves out in the same run;
 *  - the dependent leaf waits its pass: it is claimed only after alpha and beta
 *    have been claimed, judged and succeeded;
 *  - the judge pass is its own run, so no claim flows back to the hand that
 *    filed it.
 */
let trees: Tree[];
let branches: Branch[];
let leaves: Leaf[];
let tasks: Task[];
let clock = 0;

const pad = (value: number) => String(value).padStart(4, '0');

const makeLeaf = (id: string, title: string, body: string, dependsOn?: string[]): Leaf => ({
  id,
  ownerId: 'user-1',
  branchId: 'branch-1',
  title,
  body,
  column: 'todo',
  status: 'pending',
  depth: 1,
  blocking: true,
  createdAt: 'now',
  updatedAt: 'now',
  ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
});

const makeTask = (id: string, leafId: string, title: string, doneMeans: string): Task => ({
  id,
  ownerId: 'user-1',
  projectId: 'project-9',
  leafId,
  title,
  description: `${title} — write app-${title.split(' ')[1]?.toLowerCase() ?? 'x'}.ts`,
  doneMeans,
  dependsOn: [],
  status: 'proposed',
  runs: [],
  createdAt: `now-${pad(++clock)}`,
  updatedAt: `now-${pad(clock)}`,
});

const setupWorld = () => {
  trees = [{ id: 'tree-1', ownerId: 'user-1', name: 'The app', type: 'application', goal: 'A tiny web service.', projectIds: ['project-9'], createdAt: 'now', updatedAt: 'now' }];
  branches = [{ id: 'branch-1', treeId: 'tree-1', ownerId: 'user-1', title: 'The service', status: 'active', createdAt: 'now' } as unknown as Branch];
  leaves = [
    makeLeaf('leafA', 'Health endpoint', 'The app answers /health on :3000 for alpha.'),
    makeLeaf('leafB', 'Version endpoint', 'The app answers /version on :3000 for beta.'),
    makeLeaf('leafC', 'Status page', 'A status page links /health and /version for gamma.', ['leafA', 'leafB']),
  ];
  tasks = [
    makeTask('taskA', 'leafA', 'Build the /health endpoint', 'GET /health on :3000 answers 200'),
    makeTask('taskB', 'leafB', 'Build the /version endpoint', 'GET /version on :3000 answers the build string'),
    makeTask('taskC', 'leafC', 'Build the status page', 'the page links both endpoints'),
  ];
};

const world = () => ({
  trees: { list: async () => trees, save: async (tree: Tree) => { trees.push(tree); } },
  branches: { list: async () => branches, save: async (branch: Branch) => { branches.push(branch); } },
  leaves: {
    list: async () => leaves,
    save: async (leaf: Leaf) => {
      const index = leaves.findIndex((candidate) => candidate.id === leaf.id);
      if (index >= 0) leaves[index] = leaf;
      else leaves.push(leaf);
    },
  },
  tasks: { list: async () => tasks },
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
 * The scripted model. It is keyed per child run, identified by the leaf id or
 * task in the run's own conversation:
 *   leaf-ex: list its tasks -> hand the task to the executor -> file the claim -> stop
 *   exec:    do the work, say what changed -> stop
 *   judge (task-level, from do-one-task):  verdict from the evidence -> stop
 *   judge (leaf-level, from the judge pass): settle the claimed leaf -> stop
 */
function scriptedModel() {
  const rounds = new Map<string, number>();

  const classify = (seen: string, system: string): string => {
    if (system.startsWith('You run one grove leaf in your workspace')) {
      const leaf = /leaf[ABC]/.exec(seen)?.[0];
      return leaf ? `leaf-${leaf}` : 'leaf-none';
    }
    if (system.startsWith('You carry out one unit of work on a real machine')) {
      const leaf = /leaf[ABC]/.exec(seen)?.[0];
      return leaf ? `exec-${leaf}` : 'exec-none';
    }
    if (system.startsWith('You decide whether a piece of finished work meets what was asked')) {
      // The judge pass hands the claim itself (the leaf id rides inside it); a
      // task-level judge gets work signed by the seed name from the executor.
      const claimedLeaf = /leaf[ABC]/.exec(seen.includes('"claim"') || seen.includes('claim:') ? seen : 'none')?.[0];
      if (claimedLeaf) return `judge-claim-${claimedLeaf}`;
      return `judge-task-${/seed-([A-C])/.exec(seen)?.[1] ?? 'x'}`;
    }
    return 'unknown';
  };

  const leafOf = (key: string) => key.match(/leaf[ABC]/)?.[0] ?? 'leafDrop';
  const taskOf = (key: string) => `task${key.slice(-1).toUpperCase()}`;

  const bodyOf = (init: RequestInit): { content: string }[] => {
    const sent = JSON.parse((init.body as string) ?? '{}') as { messages?: { role: string; content?: string }[] };
    return (sent.messages ?? []).map((message) => ({ content: typeof message.content === 'string' ? message.content : '' }));
  };

  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const messages = bodyOf(init);
    const system = messages.find((message) => message.content.startsWith('You'))?.content ?? '';
    const seen = messages.map((message) => message.content).join('\n');
    const kind = classify(seen, system);
    const round = (rounds.get(kind) ?? 0) + 1;
    rounds.set(kind, round);

    const call = (id: string, name: string, argValues: Record<string, unknown>) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(argValues) } }] }, finish_reason: null }] } as never);
    const say = (text: string) => ({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] } as never);
    const leaf = leafOf(kind);
    const task = taskOf(kind);
    const nameText = leaf.slice(-1).toUpperCase();

    let payload: { choices: unknown[] };
    if (kind.startsWith('leaf-') && kind !== 'leaf-none') {
      if (round === 1) {
        payload = call(`c-${kind}-1`, 'list_tasks', { leafId: leaf });
      } else if (round === 2) {
        payload = call(`c-${kind}-2`, 'executor', { item: { id: task, title: `Build the ${nameText} piece`, doneMeans: 'it answers, and the output holds' , leafId: leaf } });
      } else if (round === 3) {
        payload = call(`c-${kind}-3`, 'claim_leaf', { leafId: leaf, result: 'claimed', evidence: `committed as seed-${nameText} in the workspace repo: app-${nameText}.ts answers endpoint; run output on file`, findings: 'none' });
      } else {
        payload = say(`Claimed ${leaf} for the judge.`);
      }
    } else if (kind.startsWith('exec-') && kind !== 'exec-none') {
      payload = say(`Wrote app-${nameText}.ts and committed it as seed-${nameText}; the endpoint answers 200 on :3000.`);
    } else if (kind.startsWith('judge-claim')) {
      // The claim's item carries the leaf id; re-derive it from the run's own conversation.
      const settleLeaf = /"leafId":\s*"(leaf[ABC])"/.exec(seen)?.[1] ?? /leaf[ABC]/.exec(seen)?.[0];
      const settleName = settleLeaf?.slice(-1).toUpperCase() ?? '-';
      if (round === 1) {
        payload = call(`c-judge-${round}`, 'settle_leaf', { leafId: settleLeaf, verdict: 'verified', note: `re-derived from the commit pointer seed-${settleName}; the endpoint answers` });
      } else {
        payload = say('Settled the claim.');
      }
    } else if (kind === 'judge-task') {
      payload = say('It does what was asked; the evidence holds.');
    } else if (system.startsWith('You answer one yes-or')) {
      // do-one-task's yes-or envelope check for the executor's result.
      payload = say('Yes, the work meets what was expected.');
    } else {
      payload = say('Nothing to do here.');
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
    ...createGroveTools({ stores: world(), now: () => `now-${pad(++clock)}` }),
  };

  const registry = createAgentRegistry({
    agentStore: { list: async () => ALL_SEEDED_AGENTS() },
    toolCatalogue: { list: async () => [...GROVE_TOOLS, ...TASK_TOOLS] as unknown as ToolContract[] },
  });

  const environments = createEnvironmentResolver({
    registry,
    environments: createRunEnvironments({
      provision: async ({ id, spec }) => createSandboxDriver({
        sandboxId: id,
        spec,
        backend: {
          exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          readFile: async () => '',
          writeFile: async () => undefined,
          listDir: async () => [],
          deleteFile: async () => undefined,
        },
      }),
    }),
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

  return { services, registry, handlers };
}

const ticket = (runId: string): RunTicket => ({ runId, depth: 0, ownerId: 'user-1', agentSlug: 'grove-runner', trigger: 'user' });

/** The activity's half of a grove run: partition, pass, partition, until the tree is quiet. */
async function groveRun(services: HostNodeServices, registry: AgentRegistry, handlers: Record<string, ToolHandler>) {
  type Partition = { ready: { id: string; title: string; body: string; branchId: string; taskCount: number }[]; claimed: { id: string; title: string; body: string; branchId: string; claim?: { evidence: string; at: string } }[] };
  const partition = async (): Promise<Partition> => {
    const outcome = await handlers['ready_leaves']!({
      name: 'ready_leaves',
      parsed: { treeId: 'tree-1' },
      driver: undefined,
      caller: { ownerId: 'user-1', runId: 'activity', agentSlug: 'grove-runner' },
    });
    return JSON.parse(outcome.content ?? '{}') as Partition;
  };
  const runPass = (procedure: typeof GROVE_WORK_PASS, inputs: Record<string, unknown>, runId: string) =>
    runProcedure({
      procedure,
      catalogue: builtInCatalogue(),
      groups: BUILT_IN_GROUPS,
      executor: createProcedureExecutor(services, { registry }),
      identity: { runId, depth: 0, agentId: 'grove-runner', loopId: procedure.id, loopVersion: procedure.version, trigger: 'user' },
      launch: { ownerId: 'user-1' },
      inputs,
    });

  const workItems = (leafs: Partition['ready']) =>
    leafs.map((leaf) => ({
      leafId: leaf.id,
      leafTitle: leaf.title,
      leafBody: leaf.body,
      treeId: 'tree-1',
      branchId: leaf.branchId,
      ...(leafs.length > 1 && { siblings: `${leafs.length - 1} other leaves are working in this tree at the same time — stay inside ${leaf.title}.` }),
    }));
  const claimItems = (claims: Partition['claimed']) =>
    claims.map((leaf) => ({ leafId: leaf.id, leafTitle: leaf.title, leafBody: leaf.body, treeId: 'tree-1', branchId: leaf.branchId, ...(leaf.claim ? { claim: leaf.claim } : {}) }));

  const passes: { worked?: unknown; judged?: unknown }[] = [];
  let state = await partition();
  for (let pass = 1; pass <= 5 && (state.ready.length > 0 || state.claimed.length > 0); pass += 1) {
    const entry: { worked?: unknown; judged?: unknown } = {};
    if (state.ready.length > 0) {
      entry.worked = await runPass(GROVE_WORK_PASS, { ready: workItems(state.ready) }, `pass${pass}-work`);
      state = await partition();
    }
    if (state.claimed.length > 0) {
      entry.judged = await runPass(GROVE_JUDGE_PASS, { claimed: claimItems(state.claimed) }, `pass${pass}-judge`);
      state = await partition();
    }
    passes.push(entry);
  }
  return { passes, final: state };
}

describe('the grove run in passes, end to end against real stores', () => {
  beforeEach(() => {
    clock = 0;
    setupWorld();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('works the independent leaves in one pass, judges their claims in its own, then runs the dependent one', async () => {
    const { services, registry, handlers } = engine();
    const fetchImpl = scriptedModel();
    vi.stubGlobal('fetch', fetchImpl);

    const { passes, final } = await groveRun(services, registry, handlers);

    // Two passes: pass 1 clears the independents and their claims; pass 2 the dependent one.
    expect(passes).toHaveLength(2);

    // Pass 1: both independent leaves fanned out inside the same work run.
    const pass1 = passes[0]!;
    const work1 = pass1.worked as { counters: { childRuns: number } };
    expect(work1.counters.childRuns).toBe(2);
    expect(pass1.judged).toBeDefined();
    const judge1 = pass1.judged as { counters: { childRuns: number } };
    expect(judge1.counters.childRuns).toBe(2);

    // gamma could not have run with the independents — it waits a pass.
    const pass2 = passes[1]!;
    const work2 = pass2.worked as { counters: { childRuns: number } } | undefined;
    expect(work2?.counters.childRuns).toBe(1);

    // The dependent leaf waited: its claim stamp comes after the independents' claim stamps.
    const claimAt = (id: string) => leaves.find((leaf) => leaf.id === id)?.claim?.at;
    expect(claimAt('leafC')! > claimAt('leafA')!).toBe(true);
    expect(claimAt('leafC')! > claimAt('leafB')!).toBe(true);

    // Every leaf is succeeded and verified; the judge ran its verdicts, not a worker.
    for (const id of ['leafA', 'leafB', 'leafC']) {
      const leaf = leaves.find((entry) => entry.id === id)!;
      expect(leaf.status, `${id} status`).toBe('succeeded');
      expect(leaf.verified, `${id} verified`).toBe(true);
    }

    // The model's work landed: each task went through the executor and came back done.
    expect(tasks.map((task) => task.status)).toEqual(['done', 'done', 'done']);

    // The claims carry the executor's evidence pointers.
    expect(leaves.find((leaf) => leaf.id === 'leafA')!.claim?.evidence).toContain('seed-A');

    // Nothing left to do.
    expect(final.ready).toHaveLength(0);
    expect(final.claimed).toHaveLength(0);
  });
});