import { type ToolContract } from '@koala/engine-core';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { temporalTestEnvironment } from '../../../workflows/testing/temporal-test-env.js';
import type { WorkflowHandle } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { EngineEvent, ModelProvider, Persona } from '@koala/agent-engine';
import { replyExit, stepImplementation, type ChatMessage, type ModelReply, type Procedure, type RunEffort } from '@koala/agent-engine/procedure';
import { createCompactContextNode } from '../../../engine-host/nodes/model-nodes.js';
import { inMemoryConversations } from '../../../engine-host/nodes/conversation-nodes.js';
import { createHostNodes, hostNodesFor } from '../../../engine-host/nodes/index.js';
import { createAgentRegistry } from '../../../engine-host/registries/registry.js';
import { createEffortTracker, type RunLimitsArgs } from '../../../engine-host/registries/effort.js';
import { createEnvironmentResolver } from '../../../engine-host/sandboxes/environments.js';
import { createRunEnvironments } from '../../../engine-host/sandboxes/run-environments.js';
import { createTreeWorkspaces } from '../../../engine-host/sandboxes/tree-workspaces.js';
import type { KubeRunner } from '../../../engine-host/sandboxes/kube.js';
import { createSandboxDriver } from '../../../engine-host/drivers/sandbox.js';
import { createNodeRunner } from '../../../engine-host/temporal/activities.js';
import { runCancelledVia } from '../../../engine-host/temporal/run-cancellation.js';
import { DEFAULT_STREAM_TASK_QUEUE, type GroveRunResult, type PublishArgs, type RecordTracesArgs, type ResolveAgentArgs } from '../../../engine-host/temporal/contracts.js';
import { createTaskTools } from '../../../engine-host/tools/task-tools.js';
import { TASK_TOOLS } from '../../../engine-host/tools/task-tools-catalogue.js';
import type { Task } from '../../../engine-host/tools/tasks.js';
import type { Branch, Leaf } from '../../../projects/lib/leaves.js';
import type { Tree } from '../../../projects/lib/trees.js';
import type { PlanProposal } from '../../../projects/lib/plan-proposals.js';
import { createProcedureStore } from '../../../engine-host/registries/procedure-store.js';
import { AgentRunWorkflow } from '../../../workflows/AgentRunWorkflow.js';
import { createGroveTools } from '../tools/grove-tools.js';
import { GROVE_TOOLS } from '../tools/grove-tools-catalogue.js';
import { seededAgents, seededProcedures } from '../../seeds.js';
import { extensionRuntimes, operationHandlers } from '../../runtime.js';
import type { HostOperationRun } from '../../types.js';
import { ignore } from '@koala/engine-core/failures';
import { testWorker } from '../../../workflows/testing/test-worker.js';
import type { TestTemporal } from '@koala/engine-core/testing/temporal';

const WORKFLOWS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../workflows');
const noSummaries = { resolveBaseUrl: async () => { throw new Error('nothing in this test outgrows its window'); } } as never;

export interface GroveRunOptions {
  hang?: string;
  drive?: (handle: WorkflowHandle<typeof AgentRunWorkflow>, firstCall: (kind: string) => Promise<void>) => Promise<void>;
  vanishTasksOf?: string;
  failChecksOf?: string;
  waitingTasksOf?: string;
  agent?: string;
  ownProcedures?: Procedure[];
  ownAgents?: Persona[];
  merges?: (head: string) => Promise<'merged' | 'conflict' | 'nothing' | 'failed'>;
}

const classify = (seen: string, system: string): string => {
  if (system.startsWith('You break an agreed goal into work')) {
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

export function groveWorldPerFile(environment: () => Promise<TestTemporal> = temporalTestEnvironment): GroveWorld {
  const grove = new GroveWorld();
  beforeAll(() => grove.startOn(environment));
  afterAll(() => grove.stop());
  beforeEach(() => grove.reset());
  return grove;
}

const pad = (value: number) => String(value).padStart(4, '0');

export class GroveWorld {
  trees: Tree[] = [];
  branches: Branch[] = [];
  leaves: Leaf[] = [];
  tasks: Task[] = [];
  plans: PlanProposal[] = [];
  judgeVerdicts: Record<string, string> = {};
  taskVerdict: 'yes' | 'no' = 'yes';
  writerFails: string | undefined;
  private clock = 0;

  private temporal: TestTemporal | undefined;

  constructor() {
    this.reset();
  }

  get env(): TestTemporal {
    if (!this.temporal) throw new Error('the grove world has no Temporal: its file\'s beforeAll has not started one');
    return this.temporal;
  }

  async startOn(environment: () => Promise<TestTemporal>): Promise<void> {
    this.temporal = await environment();
  }

  async stop(): Promise<void> {
    await this.temporal?.teardown();
  }

  private readonly now = (): string => `now-${pad(++this.clock)}`;

  reset(): void {
    this.clock = 0;
    this.judgeVerdicts = {};
    this.taskVerdict = 'yes';
    this.writerFails = undefined;
    this.plans = [];
    this.trees = [{ id: 'tree-1', ownerId: 'user-1', name: 'The app', type: 'application', goal: 'A tiny web service.', projectIds: ['project-9'], createdAt: 'now', updatedAt: 'now' } as Tree];
    this.branches = [{ id: 'branch-1', treeId: 'tree-1', ownerId: 'user-1', title: 'The service', createdAt: 'now' } as Branch];
    this.leaves = [
      this.leaf('leafA', 'Health endpoint', 'The app answers /health on :3000 for alpha.'),
      this.leaf('leafB', 'Version endpoint', 'The app answers /version on :3000 for beta.'),
      this.leaf('leafC', 'Status page', 'A status page links /health and /version for gamma.', ['leafA', 'leafB']),
    ];
    this.tasks = [
      this.task('taskA', 'leafA', 'Build the /health endpoint', 'GET /health on :3000 answers 200'),
      this.task('taskB', 'leafB', 'Build the /version endpoint', 'GET /version on :3000 answers the build string'),
      this.task('taskC', 'leafC', 'Build the status page', 'the page links both endpoints'),
    ];
  }

  leafOf(id: string): Leaf | undefined {
    return this.leaves.find((leaf) => leaf.id === id);
  }

  private leaf(id: string, title: string, body: string, dependsOn?: string[]): Leaf {
    return {
      id, ownerId: 'user-1', branchId: 'branch-1', title, body, status: 'pending', createdAt: 'now', updatedAt: 'now',
      ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
    };
  }

  private task(id: string, leafId: string, title: string, doneMeans: string): Task {
    return {
      id, ownerId: 'user-1', projectId: 'project-9', leafId, title, description: `${title} — write the endpoint`, doneMeans,
      dependsOn: [], status: 'accepted', runs: [], createdAt: this.now(), updatedAt: this.now(),
    };
  }

  private scriptModel(rounds: Map<string, number>, called: (kind: string) => void, hang?: string) {
    return stepImplementation('call-model', async ({ node, execution, inputs, run }) => {
      const messages = inputs.messages as ChatMessage[];
      const system = (typeof inputs.system === 'string' && inputs.system)
        ? (inputs.system as string)
        : (messages.find((message) => typeof message.content === 'string' && (message.content as string).startsWith('You'))?.content as string ?? '');
      const seen = messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n');
      const kind = classify(seen, system);
      const round = (rounds.get(kind) ?? 0) + 1;
      rounds.set(kind, round);
      called(kind);
      if (kind === hang) {
        return new Promise<never>((_, reject) => {
          const aborted = () => reject(new Error('the model call was aborted'));
          if (run.signal?.aborted) aborted();
          else run.signal?.addEventListener('abort', aborted, { once: true });
        });
      }

      const leaf = kind.match(/\bleaf[ABC]\b/)?.[0] ?? 'leafNone';
      const name = leaf.slice(-1).toUpperCase();
      const reply = (partial: Partial<ModelReply>): ModelReply => ({
        id: `${node.id}#${execution}`, content: '', thinking: '', finishReason: 'stop', toolCalls: [], ...partial,
      });

      let value: ModelReply;
      if (kind.startsWith('exec-') && kind !== 'exec-none') {
        value = reply({ content: `Wrote app-${name}.ts and committed it as seed-${name}; the endpoint answers 200 on :3000.` });
      } else if (kind.startsWith('paper-') && kind !== 'paper-none') {
        if (this.writerFails === leaf) throw ApplicationFailure.nonRetryable('the writer\'s model stopped answering mid-paper');
        value = reply({ content: `Wrote paper.md for ${leaf}: the answer in full, with a source for each claim.` });
      } else if (kind.startsWith('judge-claim')) {
        const claimed = /"leafId":\s*"(leaf[ABC])"/.exec(seen)?.[1] ?? leaf;
        const claimedName = claimed.slice(-1).toUpperCase();
        value = round === 1
          ? reply({ finishReason: 'tool_calls', toolCalls: [{ id: `c-${kind}-${round}`, name: 'settle_leaf', arguments: JSON.stringify({ leafId: claimed, verdict: this.judgeVerdicts[claimed] ?? 'verified', note: `re-derived from the commit pointer seed-${claimedName}; the endpoint answers` }) }] })
          : reply({ content: 'Settled the claim.' });
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
  }

  private decideModel() {
    return stepImplementation('decide', ({ inputs }) => {
      const raw = (inputs as { text?: unknown }).text;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
      if (this.taskVerdict === 'no') {
        return { exit: 'no', outputs: { decision: 'no', why: 'no\nthe endpoint never answered' }, usage: { rounds: 1 } };
      }
      const why = 'yes\nthe evidence re-derives from the claim; the work meets what was expected. (about: ' + text.slice(0, 120) + ')';
      return { exit: 'yes', outputs: { decision: 'yes', why }, usage: { rounds: 1 } };
    });
  }

  async run(options: GroveRunOptions = {}) {
    const env = this.env;
    const namespace = env.namespace ?? 'default';
    const published: EngineEvent[] = [];
    const traces: (RecordTracesArgs['traces'][number] & { runId: string })[] = [];
    if (options.waitingTasksOf) {
      this.tasks = this.tasks.map((task) => (task.leafId === options.waitingTasksOf ? { ...task, status: 'waiting', evidence: 'waits for the workspace to get dnf wkhtmltopdf' } : task));
    }
    if (options.failChecksOf) {
      this.tasks = this.tasks.map((task) => (task.leafId === options.failChecksOf ? { ...task, checks: { fileExists: 'missing.txt' } } : task));
    }

    const saveLeaf = async (leaf: Leaf): Promise<void> => {
      const index = this.leaves.findIndex((candidate) => candidate.id === leaf.id);
      if (index >= 0) this.leaves[index] = leaf;
      else this.leaves.push(leaf);
    };
    const saveTask = async (task: Task): Promise<void> => {
      const index = this.tasks.findIndex((candidate) => candidate.id === task.id);
      if (index >= 0) this.tasks[index] = task;
      else this.tasks.push(task);
    };
    const stores = {
      trees: { list: async () => this.trees, save: async () => undefined },
      branches: { list: async () => this.branches, save: async () => undefined },
      leaves: { list: async () => this.leaves, save: saveLeaf },
      tasks: { list: async (ownerId: string) => this.tasks.filter((task) => task.ownerId === ownerId), save: saveTask },
      plans: { list: async (ownerId: string) => this.plans.filter((entry) => entry.ownerId === ownerId) },
    };

    const seeded = seededAgents();
    const registry = createAgentRegistry({
      agentStore: { list: async () => [...seeded, ...(options.ownAgents ?? [])] },
      ...(options.ownProcedures ? { procedureStore: createProcedureStore({ builtIns: [...seededProcedures(), ...options.ownProcedures], sources: { list: async () => [] } }) } : {}),
      toolCatalogue: { list: async () => [...GROVE_TOOLS, ...TASK_TOOLS] as unknown as ToolContract[] },
    });

    const toolHandlers = {
      ...createTaskTools({ store: stores.tasks }),
      ...createGroveTools({
        stores: {
          trees: stores.trees,
          branches: stores.branches,
          leaves: stores.leaves,
          tasks: { list: async () => this.tasks },
          plans: {
            save: async (proposal: PlanProposal) => { this.plans = [...this.plans.filter((entry) => entry.id !== proposal.id), proposal]; },
            list: stores.plans.list,
          },
          treeTypes: async () => [{ id: 'application', label: 'Application', summary: 'A small service.' }],
        },
        now: this.now,
      }),
    };
    const runTool = async (args: { name: string; arguments: string; ticket: { ownerId: string; runId: string; agentSlug: string } }) => {
      const handler = toolHandlers[args.name];
      if (!handler) return { ok: false, digest: `no handler for ${args.name}` };
      const outcome = await handler({
        name: args.name,
        parsed: JSON.parse(args.arguments || '{}') as Record<string, unknown>,
        driver: undefined,
        caller: { ownerId: args.ticket.ownerId, runId: args.ticket.runId, agentSlug: args.ticket.agentSlug },
      });
      return {
        ok: outcome.ok,
        digest: outcome.digest,
        ...(outcome.content !== undefined ? { content: outcome.content } : {}),
        ...(outcome.declined ? { declined: true } : {}),
      };
    };

    const resolver = createEnvironmentResolver({
      registry,
      environments: createRunEnvironments({
        provision: async ({ id, spec }) => createSandboxDriver({
          sandboxId: id,
          spec,
          backend: {
            exec: async ({ command }) => {
              if (command.includes('missing.txt')) return { stdout: '', stderr: '', exitCode: 1 };
              return { stdout: command.includes('rev-parse') ? 'c0ffee' : '', stderr: '', exitCode: command.startsWith('test -e') ? 1 : 0 };
            },
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
    const kube: KubeRunner = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const treeWorkspaces = createTreeWorkspaces({
      ...(options.merges ? { documents: {
        save: async () => ({ saved: true as const, owner: 'koala-user-1', repo: 'tree-1', commit: 'c0ffee' }),
        restore: async () => ({ restored: false as const, why: 'not in this test' }),
        catchUp: async () => undefined,
        bring: async () => ({ brought: false as const, why: 'not in this test' }),
        merge: async (request: { head: string }) => options.merges!(request.head),
      } as never } : {}),
      resolver,
      kube,
    });
    const parkedTrees: string[] = [];
    const park = treeWorkspaces.park;
    treeWorkspaces.park = async (treeId: string, ownerId: string) => { parkedTrees.push(treeId); return park(treeId, ownerId); };

    const worktreeOfCall: string[] = [];
    const vanishingAfterStart = (handlers: Record<string, HostOperationRun>): Record<string, HostOperationRun> => ({
      ...handlers,
      'grove.start-leaf': async (request) => {
        const started = await handlers['grove.start-leaf']!(request);
        if (options.vanishTasksOf) this.tasks = this.tasks.filter((task) => task.leafId !== options.vanishTasksOf);
        return started;
      },
    });

    const models = {
      resolveBaseUrl: async () => ({
        provider: { id: 'tabby', name: 'Tabby', source: 'deployment', model: 'm', contextTokens: 32_000 } as ModelProvider,
        baseUrl: 'http://models.test/v1',
      }),
    };
    const hostNodes = hostNodesFor(createHostNodes({
      conversations: inMemoryConversations(),
      registry,
      models,
      tools: { run: runTool },
      environments: resolver,
      memories: { list: async () => [], save: async () => undefined },
      operations: vanishingAfterStart(operationHandlers(extensionRuntimes({
        grove: {
          operations: { ...stores, treeWorkspaces, environments: resolver, registry, now: this.now },
        },
      }))),
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

    const rounds = new Map<string, number>();
    const calls = new Map<string, { promise: Promise<void>; resolve: () => void }>();
    const callOf = (kind: string) => {
      let entry = calls.get(kind);
      if (!entry) {
        let resolveCall!: () => void;
        const promise = new Promise<void>((done) => { resolveCall = done; });
        entry = { promise, resolve: resolveCall };
        calls.set(kind, entry);
      }
      return entry;
    };

    const taskQueue = `grove-test-${Math.random().toString(36).slice(2, 8)}`;
    const engineWorker = await testWorker(env, {
      namespace,
      taskQueue,
      workflowsPath: WORKFLOWS,
      activities: {
        EngineRunLimitsActivity: (args: RunLimitsArgs) => tracker.limits(args),
        EngineRecordEffortActivity: (effort: RunEffort) => tracker.record(effort),
        EngineSettleClaimsActivity: async () => [] as string[],
        EngineNodeActivity: createNodeRunner(hostNodes, undefined, { carryNotices: true }),
        EngineResolveAgentActivity: async ({ ownerId, agentSlug }: ResolveAgentArgs) => {
          const runnable = await registry.runnable(ownerId, agentSlug);
          if (!runnable) return { found: false, callableAgents: [] };
          const callable = await registry.callable(ownerId, agentSlug);
          return { found: true, tools: runnable.agent.tools, procedure: runnable.procedure, callableAgents: callable.map((agent) => agent.slug) };
        },
        EngineToolActivity: async (args: { name: string; arguments: string; ticket: { ownerId: string; runId: string; agentSlug: string }; environment?: { scope?: { worktree?: string } } }) => {
          if (args.ticket.agentSlug !== 'grove-runner') worktreeOfCall.push(`${args.ticket.agentSlug} ${args.name} ${args.environment?.scope?.worktree ?? 'none'}`);
          return runTool(args);
        },
        EngineRecordTracesActivity: async (args: RecordTracesArgs) => { traces.push(...args.traces.map((trace) => ({ ...trace, runId: args.runId }))); },
      },
    });
    const streamWorker = await testWorker(env, {
      namespace,
      taskQueue: DEFAULT_STREAM_TASK_QUEUE,
      activities: {
        EngineStreamNodeActivity: createNodeRunner([this.scriptModel(rounds, (kind) => callOf(kind).resolve(), options.hang), this.decideModel(), createCompactContextNode({ models: noSummaries })], undefined, { runCancelled: runCancelledVia(async () => env.client) }),
        EnginePublishActivity: async (args: PublishArgs) => { published.push(...args.events); },
        EngineLifecycleActivity: async () => undefined,
      },
    });

    const agent = options.agent ?? 'grove';
    const runnable = await registry.runnable('user-1', agent);
    if (!runnable) throw new Error(`no agent ${agent}`);
    const runId = `grove-proof-${Math.random().toString(36).slice(2, 8)}`;
    const startAgent = async () => {
      const handle = await env.client.workflow.start(AgentRunWorkflow, {
        args: [{
          ticket: { runId, depth: 0, ownerId: 'user-1', agentSlug: agent, trigger: 'user' },
          procedure: runnable.procedure,
          inputs: { treeId: 'tree-1', message: 'Grow the tree.' },
        }],
        taskQueue,
        workflowId: runId,
      });
      if (options.drive) {
        const ended = handle.result().then(
          (result) => { throw new Error(`the run ended before the call the test waits for was made: ${JSON.stringify(result).slice(0, 2000)}`); },
          (err: unknown) => { throw new Error(`the run failed before the call the test waits for was made: ${(err as Error).message}`); },
        );
        ended.catch(ignore('the call the test waits for came first, so the run ending afterwards is not a failure of that wait'));
        await options.drive(handle, (kind) => Promise.race([callOf(kind).promise, ended]));
      }
      return handle.result();
    };
    const outcome = await engineWorker.runUntil(() => streamWorker.runUntil(startAgent));
    return { published, traces, result: outcome.outputs as unknown as GroveRunResult, outcome, parkedTrees, worktreeOfCall };
  }
}
