import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { ModelProvider } from '@koala/agent-engine';
import { ALL_SEEDED_AGENTS } from '@koala/agent-engine';
import {
  replyExit,
  stepImplementation,
  type ChatMessage,
  type ModelReply,
} from '@koala/agent-engine/procedure';
import type { ToolContract } from '@koala/engine-core';
import { GroveRunWorkflow } from './GroveRunWorkflow.js';
import { inMemoryConversations } from '../engine-host/nodes/conversation-nodes.js';
import { createHostNodes, hostNodesFor } from '../engine-host/nodes/index.js';
import { createAgentRegistry } from '../engine-host/registries/registry.js';
import { createEffortTracker, type RunLimitsArgs } from '../engine-host/registries/effort.js';
import { createEnvironmentResolver } from '../engine-host/sandboxes/environments.js';
import { createRunEnvironments, environmentIdFor } from '../engine-host/sandboxes/run-environments.js';
import { createTreeWorkspaces } from '../engine-host/sandboxes/tree-workspaces.js';
import type { KubeRunner } from '../engine-host/sandboxes/kube.js';
import { createSandboxDriver } from '../engine-host/drivers/sandbox.js';
import { createNodeRunner } from '../engine-host/temporal/activities.js';
import type { RunEffort } from '@koala/agent-engine/procedure';
import {
  DEFAULT_STREAM_TASK_QUEUE,
  type GrovePartition,
  type GroveRunResult,
  type PublishArgs,
  type RecordTracesArgs,
} from '../engine-host/temporal/contracts.js';
import { createTaskTools } from '../engine-host/tools/task-tools.js';
import { createGroveTools } from '../engine-host/tools/grove-tools.js';
import { GROVE_TOOLS } from '../engine-host/tools/grove-tools-catalogue.js';
import { TASK_TOOLS } from '../engine-host/tools/task-tools-catalogue.js';
import type { Task } from '../engine-host/tools/tasks.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The grove run proven on real Temporal: a GroveRunWorkflow (time-skipping test
 * server, real workers, real engine lane, real store-backed partition activity)
 * drives the two pass procedures against a scripted model.
 *
 * World: alpha and beta are independent leaves, each with one task; gamma waits
 * on both, so it is ready only after a judge has settled both.
 *
 * What this pins, per the pass rule, at the durable level:
 *  - pass 1 works both independent leaves inside one work run and judges both
 *    claims inside its own judge run;
 *  - the dependent leaf waits a pass;
 *  - the whole run is small activities and child workflows — nothing long-lived.
 */
let trees: Tree[];
let branches: Branch[];
let leaves: Leaf[];
let tasks: Task[];
let clock = 0;

const pad = (value: number) => String(value).padStart(4, '0');
const fixedNow = () => `now-${pad(++clock)}`;

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
  description: `${title} — write the endpoint`,
  doneMeans,
  dependsOn: [],
  status: 'proposed',
  runs: [],
  createdAt: fixedNow(),
  updatedAt: fixedNow(),
});

const setupWorld = () => {
  trees = [{ id: 'tree-1', ownerId: 'user-1', name: 'The app', type: 'application', goal: 'A tiny web service.', projectIds: ['project-9'], createdAt: 'now', updatedAt: 'now' } as Tree];
  branches = [{ id: 'branch-1', treeId: 'tree-1', ownerId: 'user-1', title: 'The service', createdAt: 'now' } as Branch];
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

const worldStores = () => {
  const replaceLeaf = async (leaf: Leaf): Promise<void> => {
    const index = leaves.findIndex((candidate) => candidate.id === leaf.id);
    if (index >= 0) leaves[index] = leaf;
    else leaves.push(leaf);
  };
  const replaceTask = async (task: Task): Promise<void> => {
    const index = tasks.findIndex((candidate) => candidate.id === task.id);
    if (index >= 0) tasks[index] = task;
    else tasks.push(task);
  };
  return {
    trees: { list: async () => trees as Tree[], save: async () => undefined },
    branches: { list: async () => branches, save: async () => undefined },
    leaves: { list: async () => leaves, save: replaceLeaf },
    tasks: { list: async () => tasks, save: replaceTask },
    readOnlySave: async (): Promise<void> => {
      throw new Error('read-only store');
    },
  };
};

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
    const claimedLeaf = /leaf[ABC]/.exec(seen.includes('"claim"') || seen.includes('claim:') ? seen : 'none')?.[0];
    if (claimedLeaf) return `judge-claim-${claimedLeaf}`;
    return `judge-task-${/seed-([A-C])/.exec(seen)?.[1] ?? 'x'}`;
  }
  return 'unknown';
};

const scriptModel = (rounds: Map<string, number>) =>
  stepImplementation('call-model', ({ node, execution, inputs }) => {
    const messages = inputs.messages as ChatMessage[];
    const system = (typeof inputs.system === 'string' && inputs.system)
      ? (inputs.system as string)
      : (messages.find((message) => typeof message.content === 'string' && (message.content as string).startsWith('You'))?.content as string ?? '');
    const seen = messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n');
    const kind = classify(seen, system);
    const round = (rounds.get(kind) ?? 0) + 1;
    rounds.set(kind, round);

    const leaf = kind.match(/leaf[ABC]/)?.[0] ?? 'leafNone';
    const name = leaf.slice(-1).toUpperCase();
    const task = `task${name}`;

    const reply = (partial: Partial<ModelReply>): ModelReply => ({
      id: `${node.id}#${execution}`,
      content: '',
      thinking: '',
      finishReason: 'stop',
      toolCalls: [],
      ...partial,
    });

    let value: ModelReply;
    if (kind.startsWith('leaf-') && kind !== 'leaf-none') {
      if (round === 1) {
        value = reply({ finishReason: 'tool_calls', toolCalls: [{ id: `c-${kind}-1`, name: 'list_tasks', arguments: JSON.stringify({ leafId: leaf }) }] });
      } else if (round === 2) {
        value = reply({ finishReason: 'tool_calls', toolCalls: [{ id: `c-${kind}-2`, name: 'executor', arguments: JSON.stringify({ item: { id: task, title: `Build the ${name} piece`, doneMeans: 'it answers, and the output holds', leafId: leaf } }) }] });
      } else if (round === 3) {
        value = reply({
          finishReason: 'tool_calls',
          toolCalls: [{ id: `c-${kind}-3`, name: 'claim_leaf', arguments: JSON.stringify({ leafId: leaf, result: 'claimed', evidence: `committed as seed-${name} in the workspace repo: app-${name}.ts answers endpoint; run output on file`, findings: 'none' }) }],
        });
      } else {
        value = reply({ content: `Claimed ${leaf} for the judge.` });
      }
    } else if (kind.startsWith('exec-') && kind !== 'exec-none') {
      value = reply({ content: `Wrote app-${name}.ts and committed it as seed-${name}; the endpoint answers 200 on :3000.` });
    } else if (kind.startsWith('judge-claim')) {
      const claimed = /"leafId":\s*"(leaf[ABC])"/.exec(seen)?.[1] ?? leaf;
      const claimedName = claimed.slice(-1).toUpperCase();
      if (round === 1) {
        value = reply({ finishReason: 'tool_calls', toolCalls: [{ id: `c-${kind}-${round}`, name: 'settle_leaf', arguments: JSON.stringify({ leafId: claimed, verdict: 'verified', note: `re-derived from the commit pointer seed-${claimedName}; the endpoint answers` }) }] });
      } else {
        value = reply({ content: 'Settled the claim.' });
      }
    } else if (kind.startsWith('judge-task')) {
      value = reply({ content: 'It does what was asked; the evidence holds.' });
    } else if (system.startsWith('You answer one yes-or')) {
      value = reply({ content: 'Yes, the work meets what was expected.' });
    } else {
      value = reply({ content: 'Nothing to do here.' });
    }

    return { exit: replyExit(value), outputs: { reply: value, toolCalls: value.toolCalls, content: value.content }, usage: { rounds: 1 } };
  });

/** Scripted verdict: the do-one-task verdict node asks of the judge's weighing whether the work holds; it holds. */
const decideModel = stepImplementation('decide', ({ node, execution, inputs }) => {
  const raw = (inputs as { text?: unknown }).text;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  const why = 'yes\nthe evidence re-derives from the claim; the work meets what was expected. (about: ' + text.slice(0, 120) + ')';
  return { exit: 'yes', outputs: { decision: 'yes', why }, usage: { rounds: 1 } };
});

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

beforeEach(() => {
  clock = 0;
  setupWorld();
});

describe('GroveRunWorkflow', () => {
  it('works the independent leaves in one pass, judges their claims in its own, and runs the dependent one next', async () => {
    const stores = worldStores();
    const rounds = new Map<string, number>();
    const registry = createAgentRegistry({
      agentStore: { list: async () => ALL_SEEDED_AGENTS() },
      toolCatalogue: { list: async () => [...GROVE_TOOLS, ...TASK_TOOLS] as unknown as ToolContract[] },
    });

    const groveTools = createGroveTools({
      stores: {
        trees: { list: stores.trees.list, save: stores.trees.save },
        branches: { list: stores.branches.list, save: stores.branches.save },
        leaves: { list: stores.leaves.list, save: stores.leaves.save },
        tasks: { list: stores.tasks.list },
      },
      now: fixedNow,
    });
    const taskstore = { list: async (ownerId: string) => tasks.filter((task) => task.ownerId === ownerId), save: stores.tasks.save };
    const toolHandlers = {
      ...createTaskTools({ store: taskstore }),
      ...groveTools,
    };

    const provisioned: string[] = [];
    const resolver = createEnvironmentResolver({
      registry,
      environments: createRunEnvironments({
        provision: async ({ id, spec }) => {
          provisioned.push(id);
          return createSandboxDriver({
            sandboxId: id,
            spec,
            backend: {
              exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
              readFile: async () => '',
              writeFile: async () => undefined,
              listDir: async () => [],
              deleteFile: async () => undefined,
            },
          });
        },
      }),
      images: {
        ensure: async (plan) => plan.base,
        exists: async () => true,
        start: async (plan) => ({ state: 'ready' as const, reference: plan.base }),
        standing: async (plan) => ({ state: 'ready' as const, reference: plan.base }),
      },
      tools: async () => [],
    });
    const describeRun = vi.spyOn(resolver, 'describe');
    const kubeCalls: string[][] = [];
    const kube: KubeRunner = async (args) => {
      kubeCalls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const treeWorkspaces = createTreeWorkspaces({ resolver, kube });
    const sandboxOfCall: (string | undefined)[] = [];

    const conversations = inMemoryConversations();
    const models = {
      resolveBaseUrl: async () => ({
        provider: { id: 'tabby', name: 'Tabby', source: 'deployment', model: 'm', contextTokens: 32_000 } as ModelProvider,
        baseUrl: 'http://models.test/v1',
      }),
    };

    const hostNodes = hostNodesFor(createHostNodes({
      conversations,
      registry,
      models,
      tools: {
        run: async (args) => {
          const handler = toolHandlers[args.name];
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
            },
          });
          return {
            ok: outcome.ok,
            digest: outcome.digest,
            ...(outcome.content !== undefined ? { content: outcome.content } : {}),
            ...(outcome.declined ? { declined: true } : {}),
          };
        },
      },
      environments: resolver,
      memories: { list: async () => [], save: async () => undefined },
    }), ['activity', 'sandbox']);

    const efforts: RunEffort[] = [];
    const tracker = createEffortTracker({
      models,
      registry,
      store: {
        save: async (effort) => { efforts.push(effort); },
        list: async (ownerId, procedureId, modelKey) => efforts.filter((effort) =>
          effort.ownerId === ownerId && effort.procedureId === procedureId && effort.modelKey === modelKey),
      },
    });

    const partitionCalls = vi.fn(async (_args: { treeId: string }): Promise<GrovePartition> => {
      const outcome = await groveTools['ready_leaves']!({
        name: 'ready_leaves',
        parsed: { treeId: _args.treeId },
        driver: undefined,
        caller: { ownerId: 'user-1', runId: 'partition' },
      });
      if (!outcome.ok) throw new Error(outcome.digest);
      const parsed = JSON.parse(outcome.content ?? '{}') as { ready?: unknown[]; claimed?: unknown[]; settled?: unknown[] };
      const partition: GrovePartition = { ready: (parsed.ready ?? []) as GrovePartition['ready'], claimed: (parsed.claimed ?? []) as GrovePartition['claimed'], settledCount: (parsed.settled ?? []).length };
      return partition;
    });

    const taskQueue = `grove-test-${Math.random().toString(36).slice(2, 8)}`;
    const engineWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: resolve(__dirname),
      activities: {
        GrovePartitionActivity: partitionCalls,
        GroveWorkspaceActivity: vi.fn((args: { treeId: string; ownerId: string }) => treeWorkspaces.describe(args)),
        GroveParkWorkspaceActivity: vi.fn((args: { treeId: string }) => treeWorkspaces.park(args.treeId)),
        EngineRunLimitsActivity: vi.fn((args: RunLimitsArgs) => tracker.limits(args)),
        EngineRecordEffortActivity: vi.fn((effort: RunEffort) => tracker.record(effort)),
        EngineSettleClaimsActivity: vi.fn(async () => [] as string[]),
        EngineNodeActivity: createNodeRunner(hostNodes, undefined),
        EngineResolveAgentActivity: vi.fn(async ({ ownerId, agentSlug }) => {
          const runnable = await registry.runnable(ownerId, agentSlug);
          if (!runnable) return { found: false, callableAgents: [] };
          const callable = await registry.callable(ownerId, agentSlug);
          return {
            found: true,
            tools: runnable.agent.tools,
            procedure: runnable.procedure,
            callableAgents: callable.map((agent) => agent.slug),
          };
        }),
        EngineToolActivity: vi.fn(async (args: { name: string; arguments: string; ticket: Record<string, unknown>; environment?: { id: string } }) => {
          if (args.ticket.agentSlug !== 'grove-runner') sandboxOfCall.push(args.environment?.id);
          const handler = toolHandlers[args.name];
          if (!handler) return { ok: false, digest: `no handler for ${args.name}` };
          const parsed = JSON.parse(args.arguments || '{}') as Record<string, unknown>;
          const ticket = args.ticket as { ownerId: string; runId: string; agentSlug: string };
          const outcome = await handler({
            name: args.name,
            parsed,
            driver: undefined,
            caller: { ownerId: ticket.ownerId, runId: ticket.runId, agentSlug: ticket.agentSlug },
          });
          return {
            ok: outcome.ok,
            digest: outcome.digest,
            ...(outcome.content !== undefined ? { content: outcome.content } : {}),
            ...(outcome.declined ? { declined: true } : {}),
          };
        }),
        EngineRecordTracesActivity: vi.fn(async (_args: RecordTracesArgs) => undefined),
      },
    });

    const streamWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: DEFAULT_STREAM_TASK_QUEUE,
      activities: {
        EngineStreamNodeActivity: createNodeRunner([scriptModel(rounds), decideModel], undefined),
        EnginePublishActivity: vi.fn(async (_args: PublishArgs) => undefined),
      },
    });

    const runId = `grove-proof-${Math.random().toString(36).slice(2, 8)}`;
    const start = async () => {
      const handle = await env.client.workflow.start(GroveRunWorkflow, {
        args: [{ treeId: 'tree-1', ownerId: 'user-1' }],
        taskQueue,
        workflowId: runId,
      });
      return (await handle.result()) as GroveRunResult;
    };

    const result = await engineWorker.runUntil(() => streamWorker.runUntil(start));

    // Two passes: pass 1 clears the independents and their claims; pass 2 the dependent one.
    expect(result).toEqual({ treeId: 'tree-1', outcome: 'quiet', passes: 2 });

    // Pass structure: the partition ran at each boundary — start, after each work pass, and the final quiet read.
    expect(partitionCalls).toHaveBeenCalledTimes(5);

    // Every leaf is succeeded and verified; the judge ran the verdicts, not the work.
    for (const id of ['leafA', 'leafB', 'leafC']) {
      const leaf = leaves.find((entry) => entry.id === id)!;
      expect(leaf.status, `${id} status`).toBe('succeeded');
      expect(leaf.verified, `${id} verified`).toBe(true);
    }

    // The dependent leaf waited a pass: its claim stamp comes after both independents'.
    const claimAt = (id: string) => leaves.find((leaf) => leaf.id === id)?.claim?.at;
    expect(claimAt('leafC')! > claimAt('leafA')!).toBe(true);
    expect(claimAt('leafC')! > claimAt('leafB')!).toBe(true);

    // The model's work landed through the executor and its task judge.
    expect(tasks.map((task) => task.status)).toEqual(['done', 'done', 'done']);

    // The passes made their own engine runs: two work passes, two judge passes, nothing else.
    const byProcedure = (id: string) => efforts.filter((effort) => effort.procedureId === id);
    expect(byProcedure('grove-work-pass')).toHaveLength(2);
    expect(byProcedure('grove-judge-pass')).toHaveLength(2);

    expect(sandboxOfCall.length).toBeGreaterThan(0);
    expect(new Set(sandboxOfCall)).toEqual(new Set([environmentIdFor('tree-tree-1')]));
    expect(describeRun).not.toHaveBeenCalled();
    expect(provisioned.every((id) => id === environmentIdFor('tree-tree-1'))).toBe(true);

    expect(kubeCalls.map((args) => args.slice(0, 2).join(' '))).toEqual(['delete pod']);
  }, 60_000);
});