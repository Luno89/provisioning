import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { WorkflowClient } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { ModelProvider, Persona } from '@koala/agent-engine';

import {
  replyExit,
  stepImplementation,
  type ChatMessage,
  type ModelReply,
} from '@koala/agent-engine/procedure';
import type { ToolContract } from '@koala/engine-core';
import { inMemoryConversations } from '../../engine-host/nodes/conversation-nodes.js';
import { createHostNodes, hostNodesFor } from '../../engine-host/nodes/index.js';
import { createAgentRegistry } from '../../engine-host/registries/registry.js';
import { createEffortTracker, type RunLimitsArgs } from '../../engine-host/registries/effort.js';
import { createEnvironmentResolver } from '../../engine-host/sandboxes/environments.js';
import { createRunEnvironments } from '../../engine-host/sandboxes/run-environments.js';
import { createTreeWorkspaces } from '../../engine-host/sandboxes/tree-workspaces.js';
import type { KubeRunner } from '../../engine-host/sandboxes/kube.js';
import { createSandboxDriver } from '../../engine-host/drivers/sandbox.js';
import { createNodeRunner } from '../../engine-host/temporal/activities.js';
import { runCancelledVia } from '../../engine-host/temporal/run-cancellation.js';
import type { Procedure, RunEffort } from '@koala/agent-engine/procedure';
import {
  DEFAULT_STREAM_TASK_QUEUE,
  type GroveRunResult,
  type PublishArgs,
  type RecordTracesArgs,
} from '../../engine-host/temporal/contracts.js';
import { createTaskTools } from '../../engine-host/tools/task-tools.js';
import { createGroveTools } from './tools/grove-tools.js';
import { GROVE_TOOLS } from './tools/grove-tools-catalogue.js';
import { TASK_TOOLS } from '../../engine-host/tools/task-tools-catalogue.js';
import type { Task } from '../../engine-host/tools/tasks.js';
import type { Branch, Leaf } from '../../lib/leaves.js';
import type { Tree } from '../../lib/trees.js';
import type { PlanProposal } from '../../lib/plan-proposals.js';
import { seededPersonas, seededProcedures } from '../seeds.js';
import { extensionRuntimes, operationHandlers } from '../runtime.js';
import type { HostOperationRun } from '../types.js';
import { createProcedureStore } from '../../engine-host/registries/procedure-store.js';
import { AgentRunWorkflow, cancelSignal } from '../../workflows/AgentRunWorkflow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The grove run proven on real Temporal: the grove agent's procedure in an AgentRunWorkflow (time-skipping test
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
let judgeVerdicts: Record<string, string> = {};
let taskVerdict: 'yes' | 'no' = 'yes';
let plans: PlanProposal[] = [];

const pad = (value: number) => String(value).padStart(4, '0');
const fixedNow = () => `now-${pad(++clock)}`;

const makeLeaf = (id: string, title: string, body: string, dependsOn?: string[]): Leaf => ({
  id,
  ownerId: 'user-1',
  branchId: 'branch-1',
  title,
  body,
  status: 'pending',
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
  status: 'accepted',
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
  if (system.startsWith('You break an agreed goal into work')) {
    // The planner is handed its inputs labelled, one per line (`leafId: leafA`) — not as a JSON blob it has to unpick.
    const leaf = /^leafId: (leaf[ABC])$/m.exec(seen)?.[1];
    return leaf ? `planner-${leaf}` : 'planner-none';
  }
  if (system.startsWith('You carry out one unit of work on a real machine')) {
    const leaf = /\bleaf[ABC]\b/.exec(seen)?.[0];
    return leaf ? `exec-${leaf}` : 'exec-none';
  }
  if (system.startsWith("You settle one grove leaf's claim")) {
    const claimedLeaf = /"leafId":\s*"(leaf[ABC])"/.exec(seen)?.[1] ?? /\bleaf[ABC]\b/.exec(seen)?.[0];
    return claimedLeaf ? `judge-claim-${claimedLeaf}` : 'judge-claim-none';
  }
  if (system.startsWith('You decide whether a piece of finished work meets what was asked')) {
    const claimedLeaf = /\bleaf[ABC]\b/.exec(seen.includes('"claim"') || seen.includes('claim:') ? seen : 'none')?.[0];
    if (claimedLeaf) return `judge-claim-${claimedLeaf}`;
    return `judge-task-${/seed-([A-C])/.exec(seen)?.[1] ?? 'x'}`;
  }
  if (system.startsWith('You work one leaf of a research paper')) {
    const written = /\bleaf[ABC]\b/.exec(seen)?.[0];
    return written ? `paper-${written}` : 'paper-none';
  }
  return 'unknown';
};

const scriptModel = (rounds: Map<string, number>, hang?: string) =>
  stepImplementation('call-model', async ({ node, execution, inputs, run }) => {
    const messages = inputs.messages as ChatMessage[];
    const system = (typeof inputs.system === 'string' && inputs.system)
      ? (inputs.system as string)
      : (messages.find((message) => typeof message.content === 'string' && (message.content as string).startsWith('You'))?.content as string ?? '');
    const seen = messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n');
    const kind = classify(seen, system);
    const round = (rounds.get(kind) ?? 0) + 1;
    rounds.set(kind, round);
    if (kind === hang) {
      return new Promise<never>((_, reject) => {
        run.signal?.addEventListener('abort', () => reject(new Error('the model call was aborted')));
      });
    }

    const leaf = kind.match(/\bleaf[ABC]\b/)?.[0] ?? 'leafNone';
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
    } else if (kind.startsWith('paper-') && kind !== 'paper-none') {
      // One run, no task list: the leaf is written rather than worked through.
      value = reply({ content: `Wrote paper.md for ${leaf}: the answer in full, with a source for each claim.` });
    } else if (kind.startsWith('judge-claim')) {
      const claimed = /"leafId":\s*"(leaf[ABC])"/.exec(seen)?.[1] ?? leaf;
      const claimedName = claimed.slice(-1).toUpperCase();
      if (round === 1) {
        value = reply({ finishReason: 'tool_calls', toolCalls: [{ id: `c-${kind}-${round}`, name: 'settle_leaf', arguments: JSON.stringify({ leafId: claimed, verdict: judgeVerdicts[claimed] ?? 'verified', note: `re-derived from the commit pointer seed-${claimedName}; the endpoint answers` }) }] });
      } else {
        value = reply({ content: 'Settled the claim.' });
      }
    } else if (kind.startsWith('planner-') && kind !== 'planner-none') {
      value = round === 1
        ? reply({
          finishReason: 'tool_calls',
          toolCalls: [{ id: `c-${kind}-1`, name: 'propose_leaf_plan', arguments: JSON.stringify({
            leafId: leaf,
            mode: 'replan',
            why: `the failure says the ${name} endpoint never started; start it before probing`,
            brief: `Start app-${name}.ts, then probe it.`,
            tasks: [{ key: 'start', title: `Start the ${name} endpoint`, description: `Run app-${name}.ts in the background, then curl it`, role: 'Makes the probe possible', doneMeans: 'curl answers 200' }],
          }) }],
        })
        : reply({ content: `Proposed a replan for ${leaf}.` });
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
  if (taskVerdict === 'no') {
    return { exit: 'no', outputs: { decision: 'no', why: 'no\nthe endpoint never answered' }, usage: { rounds: 1 } };
  }
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
  judgeVerdicts = {};
  taskVerdict = 'yes';
  plans = [];
  setupWorld();
});

async function runGroveWorld(options: {
  hang?: string;
  drive?: (handle: { signal: (...args: never[]) => Promise<void> }, rounds: Map<string, number>) => Promise<void>;
  /** take this leaf's tasks away once the first partition has read them — the race the work stage must survive */
  vanishTasksOf?: string;
  /** give this leaf's task a check that fails, so its claim is settled by code rather than judged */
  failChecksOf?: string;
  /** the grove agent whose procedure grows the tree — `grove` unless a test names another */
  agent?: string;
  /** procedures and agents the world's owner has of their own, beside the seeded ones */
  ownProcedures?: Procedure[];
  ownAgents?: Persona[];
} = {}) {
  if (options.failChecksOf) {
    tasks = tasks.map((task) => (task.leafId === options.failChecksOf ? { ...task, checks: { fileExists: 'missing.txt' } } : task));
  }
  const client = options.drive ? new WorkflowClient({ connection: env.connection }) : env.client.workflow;
    const stores = worldStores();
    const rounds = new Map<string, number>();
    const seeded = seededPersonas();
    const registry = createAgentRegistry({
      agentStore: { list: async () => [...seeded, ...(options.ownAgents ?? [])] },
      ...(options.ownProcedures ? { procedureStore: createProcedureStore({ builtIns: [...seededProcedures(), ...options.ownProcedures], sources: { list: async () => [] } }) } : {}),
      toolCatalogue: { list: async () => [...GROVE_TOOLS, ...TASK_TOOLS] as unknown as ToolContract[] },
    });

    const groveTools = createGroveTools({
      stores: {
        trees: { list: stores.trees.list, save: stores.trees.save },
        branches: { list: stores.branches.list, save: stores.branches.save },
        leaves: { list: stores.leaves.list, save: stores.leaves.save },
        tasks: { list: stores.tasks.list },
        plans: {
          save: async (proposal: PlanProposal) => { plans = [...plans.filter((entry) => entry.id !== proposal.id), proposal]; },
          list: async (ownerId: string) => plans.filter((entry) => entry.ownerId === ownerId),
        },
        treeTypes: async () => [{ id: 'application', label: 'Application', summary: 'A small service.' }],
      },
      now: fixedNow,
    });
    const taskstore = { list: async (ownerId: string) => tasks.filter((task) => task.ownerId === ownerId), save: stores.tasks.save };
    const toolHandlers = {
      ...createTaskTools({ store: taskstore }),
      ...groveTools,
    };

    const provisioned: string[] = [];
    const gitCommands: string[] = [];
    const resolver = createEnvironmentResolver({
      registry,
      environments: createRunEnvironments({
        provision: async ({ id, spec }) => {
          provisioned.push(id);
          return createSandboxDriver({
            sandboxId: id,
            spec,
            backend: {
              exec: async ({ command }) => {
                gitCommands.push(command);
                if (command.includes('missing.txt')) return { stdout: '', stderr: '', exitCode: 1 };
                return { stdout: command.includes('rev-parse') ? 'c0ffee' : '', stderr: '', exitCode: command.startsWith('test -e') ? 1 : 0 };
              },
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
    const sharedWith: string[][] = [];
    const treeWorkspaces = createTreeWorkspaces({
      resolver: {
        ...resolver,
        describeShared: async (request: Parameters<typeof resolver.describeShared>[0]) => {
          sharedWith.push([...request.agents]);
          return resolver.describeShared(request);
        },
      },
      kube,
    });
    const sandboxOfCall: string[] = [];
    const worktreeOfCall: string[] = [];
    const vanishingAfterStart = (handlers: Record<string, HostOperationRun>): Record<string, HostOperationRun> => ({
      ...handlers,
      'grove.start-leaf': async (request) => {
        const started = await handlers['grove.start-leaf']!(request);
        if (options.vanishTasksOf) tasks = tasks.filter((task) => task.leafId !== options.vanishTasksOf);
        return started;
      },
    });

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
      operations: vanishingAfterStart(operationHandlers(extensionRuntimes({
        grove: {
          operations: {
            trees: stores.trees,
            branches: stores.branches,
            leaves: stores.leaves,
            tasks: { list: async (ownerId: string) => tasks.filter((task) => task.ownerId === ownerId), save: stores.tasks.save },
            plans: { list: async (ownerId: string) => plans.filter((entry) => entry.ownerId === ownerId) },
            treeWorkspaces,
            environments: resolver,
            registry,
            now: fixedNow,
          },
        },
      }))),
    }), ['activity', 'sandbox']);

    const efforts: RunEffort[] = [];
    const parkedTrees: string[] = [];
    const park = treeWorkspaces.park;
    treeWorkspaces.park = async (treeId: string) => { parkedTrees.push(treeId); await park(treeId); };
    const tracker = createEffortTracker({
      models,
      registry,
      store: {
        save: async (effort) => { efforts.push(effort); },
        list: async (ownerId, procedureId, modelKey) => efforts.filter((effort) =>
          effort.ownerId === ownerId && effort.procedureId === procedureId && effort.modelKey === modelKey),
      },
    });

    const taskQueue = `grove-test-${Math.random().toString(36).slice(2, 8)}`;
    const engineWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: resolve(__dirname, '../../workflows'),
      activities: {
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
          if (args.ticket.agentSlug !== 'grove-runner' && args.environment) sandboxOfCall.push(args.environment.id);
          if (args.ticket.agentSlug !== 'grove-runner') {
            const where = (args.environment as { scope?: { worktree?: string } } | undefined)?.scope?.worktree ?? 'none';
            worktreeOfCall.push(`${args.ticket.agentSlug} ${args.name} ${where}`);
          }
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
        EngineStreamNodeActivity: createNodeRunner([scriptModel(rounds, options.hang), decideModel], undefined, { runCancelled: runCancelledVia(async () => env.client) }),
        EnginePublishActivity: vi.fn(async (_args: PublishArgs) => undefined),
      },
    });

    const runId = `grove-proof-${Math.random().toString(36).slice(2, 8)}`;
    const agent = options.agent ?? 'grove';
    {
      const runnable = await registry.runnable('user-1', agent);
      if (!runnable) throw new Error(`no agent ${agent}`);
      const startAgent = async () => {
        const handle = await client.start(AgentRunWorkflow, {
          args: [{
            ticket: { runId, depth: 0, ownerId: 'user-1', agentSlug: agent, trigger: 'user' },
            procedure: runnable.procedure,
            inputs: { treeId: 'tree-1', message: 'Grow the tree.' },
          }],
          taskQueue,
          workflowId: runId,
        });
        if (options.drive) await options.drive(handle as never, rounds);
        return handle.result();
      };
      const outcome = await engineWorker.runUntil(() => streamWorker.runUntil(startAgent));
      return { result: outcome.outputs as unknown as GroveRunResult, outcome, parkedTrees, efforts, sandboxOfCall, worktreeOfCall, gitCommands, provisioned, describeRun, kubeCalls, sharedWith };
    }
}

const waitFor = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
};

describe('the grove agent\'s procedure', () => {
  it('works the independent leaves, judges their claims, then works and judges the leaf that waited on them', async () => {
    const { result, outcome, worktreeOfCall } = await runGroveWorld({ agent: 'grove' });

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ outcome: 'ok' });
    expect(result).toEqual({ treeId: 'tree-1', outcome: 'quiet', awaitingReview: [], awaitingApproval: [] });
    for (const id of ['leafA', 'leafB', 'leafC']) {
      expect(leaves.find((leaf) => leaf.id === id), id).toMatchObject({ status: 'succeeded', verified: true });
    }
    expect(worktreeOfCall.some((call) => call.startsWith('executor ') && call.endsWith('trees/leafA'))).toBe(true);
    expect(worktreeOfCall.some((call) => call.startsWith('leaf-judge settle_leaf'))).toBe(true);
  }, 120_000);

  it('plans a failed leaf again with its failure in its worktree, and reports the plan waiting for a person', async () => {
    judgeVerdicts = { leafB: 'failed' };

    const { result } = await runGroveWorld({ agent: 'grove' });

    expect(leaves.find((leaf) => leaf.id === 'leafB')).toMatchObject({ status: 'failed' });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ status: 'proposed', leafPlan: { leafId: 'leafB', mode: 'replan' } });
    expect(result).toEqual({ treeId: 'tree-1', outcome: 'quiet', awaitingReview: [], awaitingApproval: [plans[0]!.id] });
    expect(leaves.find((leaf) => leaf.id === 'leafC')?.status).toBe('pending');
  }, 120_000);

  it('settles a claim whose own checks fail without a judge, and plans it again', async () => {
    const { worktreeOfCall } = await runGroveWorld({ agent: 'grove', failChecksOf: 'leafA' });

    expect(leaves.find((leaf) => leaf.id === 'leafA')).toMatchObject({ status: 'failed', review: { model: 'grove-check-runner' } });
    expect(worktreeOfCall.filter((call) => call.startsWith('leaf-judge') && call.includes('leafA'))).toEqual([]);
    expect(plans.map((plan) => plan.leafPlan?.leafId)).toContain('leafA');
  }, 120_000);

  it('puts a leaf that turns out to have no tasks back for the planner', async () => {
    await runGroveWorld({ agent: 'grove', vanishTasksOf: 'leafA' });

    expect(leaves.find((leaf) => leaf.id === 'leafA')).toMatchObject({ status: 'pending' });
    expect(leaves.find((leaf) => leaf.id === 'leafA')?.claim).toBeUndefined();
    expect(plans.map((plan) => plan.leafPlan?.leafId)).toEqual(['leafA']);
  }, 120_000);

  it('honours a limit set on a copy of the procedure: no replans means a failed leaf is left for the person', async () => {
    judgeVerdicts = { leafB: 'failed' };
    const careful: Procedure = {
      ...seededProcedures().find((procedure) => procedure.id === 'grove-run')!,
      id: 'grove-run-careful',
    };
    careful.nodes = careful.nodes.map((node) => (node.id === 'needs' ? { ...node, settings: { ...node.settings, replans: 0 } } : node));
    const grove = seededPersonas().find((persona) => persona.slug === 'grove')!;

    const { result } = await runGroveWorld({ agent: 'grove-careful', ownProcedures: [careful], ownAgents: [{ ...grove, slug: 'grove-careful', procedure: 'grove-run-careful' }] });

    expect(leaves.find((leaf) => leaf.id === 'leafB')).toMatchObject({ status: 'failed' });
    expect(plans).toEqual([]);
    expect(result).toMatchObject({ outcome: 'quiet', awaitingApproval: [] });
  }, 120_000);

  it('fails a leaf whose task used the attempts its Next Task allows, with the tool\'s own reason', async () => {
    taskVerdict = 'no';
    const limited: Procedure = { ...seededProcedures().find((procedure) => procedure.id === 'grove-leaf')!, id: 'grove-leaf-limited' };
    limited.nodes = limited.nodes.map((node) => (node.id === 'next' ? { ...node, settings: { ...node.settings, taskAttempts: 2 } } : node));
    const run: Procedure = { ...seededProcedures().find((procedure) => procedure.id === 'grove-run')!, id: 'grove-run-limited' };
    run.nodes = run.nodes.map((node) => (node.id === 'work' ? { ...node, settings: { ...node.settings, agent: 'grove-leaf-limited' } } : node));
    const grove = seededPersonas().find((persona) => persona.slug === 'grove')!;
    const leafAgent = seededPersonas().find((persona) => persona.slug === 'grove-leaf')!;

    await runGroveWorld({
      agent: 'grove-limited',
      ownProcedures: [limited, run],
      ownAgents: [
        { ...grove, slug: 'grove-limited', procedure: 'grove-run-limited', agents: ['grove-leaf-limited', 'leaf-judge', 'planner'] },
        { ...leafAgent, slug: 'grove-leaf-limited', procedure: 'grove-leaf-limited' },
      ],
    });

    const leafA = leaves.find((entry) => entry.id === 'leafA')!;
    expect(leafA.status).toBe('failed');
    expect(leafA.findings ?? '').toMatch(/failed 2 times/);
  }, 120_000);

  it('has the paper writer write each leaf in one run, and the claim carries what it said', async () => {
    trees = trees.map((tree) => ({ ...tree, type: 'research-paper' }));

    const { result, worktreeOfCall } = await runGroveWorld({ agent: 'grove-paper', vanishTasksOf: 'leafA' });

    expect(result).toMatchObject({ treeId: 'tree-1', outcome: 'quiet' });
    expect(leaves.every((leaf) => leaf.status === 'succeeded'), JSON.stringify(leaves.map((leaf) => [leaf.id, leaf.status]))).toBe(true);
    expect(worktreeOfCall.filter((call) => call.startsWith('executor'))).toEqual([]);
    expect(leaves.find((leaf) => leaf.id === 'leafA')?.claim?.evidence ?? '').toContain('Wrote paper.md for leafA');
  }, 120_000);

  it('cancelling one leaf stops its run alone, and the rest of the tree is still worked', async () => {
    await runGroveWorld({
      hang: 'exec-leafA',
      drive: async (_handle, rounds) => {
        await waitFor(() => (rounds.get('exec-leafA') ?? 0) > 0, 'leaf A\'s task to start');
        const leafA = leaves.find((leaf) => leaf.id === 'leafA')!;
        expect(leafA.runId, 'the leaf does not say which run is working it').toBeTruthy();
        leaves = leaves.map((leaf) => (leaf.id === 'leafA' ? { ...leaf, status: 'cancelled' } : leaf));
        await env.client.workflow.getHandle(leafA.runId!).signal(cancelSignal);
      },
    });

    expect(leaves.find((leaf) => leaf.id === 'leafA')?.status).toBe('cancelled');
    expect(leaves.find((leaf) => leaf.id === 'leafB')).toMatchObject({ status: 'succeeded', verified: true });
  }, 120_000);

  it('stopping the run stops the leaf mid-task, puts it back to waiting and parks the workspace', async () => {
    const { outcome, parkedTrees } = await runGroveWorld({
      agent: 'grove',
      hang: 'exec-leafA',
      drive: async (handle, rounds) => {
        await waitFor(() => (rounds.get('exec-leafA') ?? 0) > 0, 'leaf A\'s task to start');
        await handle.signal(cancelSignal as never);
      },
    });

    expect(outcome).toMatchObject({ outcome: 'interrupted' });
    expect(leaves.find((leaf) => leaf.id === 'leafA')).toMatchObject({ status: 'pending' });
    expect(leaves.find((leaf) => leaf.id === 'leafA')?.claim).toBeUndefined();
    expect(parkedTrees).toEqual(['tree-1']);
  }, 120_000);
});
