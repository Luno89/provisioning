import { Context } from '@temporalio/activity';
import { abandonedBy, type Task } from '../tools/tasks.js';
import {
  callModel,
  type EngineEndpoint,
  type Monitor,
  type EventBus,
} from '@koala/agent-engine';
import { UNRESOLVED_MODEL, type EffortTracker, type RunLimits, type RunLimitsArgs } from '../registries/effort.js';
import type { RunEffort } from '@koala/agent-engine/procedure';
import {
  builtInCatalogue,
  type NodeCatalogue,
  type NodeImplementation,
  type NodeRequest,
} from '@koala/agent-engine/procedure';
import type {
  GrovePartition,
  GrovePartitionArgs,
  GroveWorkspaceArgs,
  AdoptPlanArgs,
  GrovePrepareWorkArgs,
  GrovePreparedWork,
  GroveJudgeCheckoutArgs,
  GroveJudgeCheckouts,
  MergeArgs,
  MergeRuntime,
  PublishArgs,
  RecordTracesArgs,
  ReleaseEnvironmentArgs,
  RemoteNodeRequest,
  RemoteNodeResult,
  ResolveAgentArgs,
  ResolvedAgentInfo,
  ResolveEnvironmentArgs,
  RunEnvironment,
  ToolCallArgs,
  ToolCallOutcome,
  ToolRuntime,
  SettleClaimsArgs,
} from './contracts.js';
import { createGroveTools } from '../tools/grove-tools.js';
import type { TreeSandbox, TreeWorkspaces } from '../sandboxes/tree-workspaces.js';
import type { AdoptedRecords, PlanAdoption } from '../plan-adoption.js';
import { prepareJudgeCheckout, prepareLeafWorktree, WorktreeConflictError } from '../grove-worktrees.js';
import type { AdoptedPlan } from '../../lib/plan-proposals.js';
import type { Tree } from '../../lib/trees.js';
import type { Branch, Leaf } from '../../lib/leaves.js';
import type { AgentRegistry } from '../registries/registry.js';
import type { EnvironmentResolver } from '../sandboxes/environments.js';

export interface EndpointResolver {
  forAgent(input: { ownerId: string; agentSlug: string }): Promise<{
    endpoint: EngineEndpoint;
    sampling?: Parameters<typeof callModel>[0]['sampling'];
    maxTokens: number;
  }>;
}

export interface StreamServices {
  registry: AgentRegistry;
  endpoints: EndpointResolver;
  bus: EventBus;
  streamMonitors?: ((request: NodeRequest) => Monitor[]) | undefined;
  streamNodes?: readonly NodeImplementation[] | undefined;
}

export interface TraceRecorder {
  record(args: RecordTracesArgs): Promise<void>;
}

export interface EngineServices extends StreamServices {
  tools: ToolRuntime;
  merges: MergeRuntime;
  environments: EnvironmentResolver;
  hostNodes?: readonly NodeImplementation[] | undefined;
  traces?: TraceRecorder | undefined;
  effort?: EffortTracker | undefined;
  tasks?: { list(ownerId: string): Promise<Task[]>; save(task: Task): Promise<void> } | undefined;
  /** the grove's tree stores (read-only use by the partition activity) */
  grove?: GroveStores | undefined;
  treeWorkspaces?: TreeWorkspaces | undefined;
  planAdoption?: PlanAdoption | undefined;
}

/** Read-side of a grove's stores: just enough for the ready-leaves partition. */
export interface GroveStores {
  trees: { list(): Promise<Tree[]> };
  branches: { list(): Promise<Branch[]> };
  leaves: { list(): Promise<Leaf[]>; save?(leaf: Leaf): Promise<void> };
  tasks: { list(): Promise<Task[]> };
}

export interface StreamActivities {
  EnginePublishActivity(args: PublishArgs): Promise<void>;
  EngineStreamNodeActivity(request: RemoteNodeRequest): Promise<RemoteNodeResult>;
}

export const NODE_HEARTBEAT_MS = 10_000;

function currentActivity(): Context | undefined {
  try {
    return Context.current();
  } catch {
    return undefined;
  }
}

export function createNodeRunner(
  implementations: readonly NodeImplementation[],
  bus: EventBus | undefined,
  catalogue: NodeCatalogue = builtInCatalogue(),
): (request: RemoteNodeRequest) => Promise<RemoteNodeResult> {
  const byKind = new Map(implementations.map((implementation) => [implementation.kind, implementation]));

  return async (request) => {
    const implementation = byKind.get(request.node.kind);
    const definition = catalogue.get(request.node.kind);
    if (!implementation || !definition) {
      throw new Error(`this worker cannot run a "${request.node.kind}" node`);
    }

    const full: NodeRequest = {
      node: request.node,
      origin: request.origin,
      definition,
      inputs: request.inputs,
      ...(request.previous ? { previous: request.previous } : {}),
      execution: request.execution,
      run: {
        ...request.run,
        emit: (event) => bus?.emit({ ...event, runId: request.run.identity.runId, at: new Date().toISOString() } as never),
      },
    };

    const context = currentActivity();
    const beating = context ? setInterval(() => context.heartbeat(), NODE_HEARTBEAT_MS) : undefined;
    try {
      return await implementation.run(full);
    } finally {
      if (beating) clearInterval(beating);
    }
  };
}

export interface EngineActivities extends StreamActivities {
  EngineResolveEnvironmentActivity(args: ResolveEnvironmentArgs): Promise<RunEnvironment>;
  EngineReleaseEnvironmentActivity(args: ReleaseEnvironmentArgs): Promise<void>;
  EngineResolveAgentActivity(args: ResolveAgentArgs): Promise<ResolvedAgentInfo>;
  EngineToolActivity(args: ToolCallArgs): Promise<ToolCallOutcome>;
  EngineMergeActivity(args: MergeArgs): Promise<Record<string, unknown>>;
  GrovePartitionActivity(args: GrovePartitionArgs): Promise<GrovePartition>;
  GroveWorkspaceActivity(args: GroveWorkspaceArgs): Promise<TreeSandbox>;
  GroveParkWorkspaceActivity(args: GroveWorkspaceArgs): Promise<void>;
  GrovePrepareWorkActivity(args: GrovePrepareWorkArgs): Promise<GrovePreparedWork>;
  GroveJudgeCheckoutActivity(args: GroveJudgeCheckoutArgs): Promise<GroveJudgeCheckouts>;
  PlanAdoptRecordsActivity(args: AdoptPlanArgs): Promise<AdoptedRecords>;
  PlanAdoptDocumentsActivity(args: AdoptPlanArgs & { records: AdoptedRecords }): Promise<string>;
  PlanAdoptSettleActivity(args: AdoptPlanArgs & { status: 'adopted' | 'failed'; adopted?: AdoptedPlan | undefined; reason?: string | undefined }): Promise<void>;
  EngineNodeActivity(request: RemoteNodeRequest): Promise<RemoteNodeResult>;
  EngineRecordTracesActivity(args: RecordTracesArgs): Promise<void>;
  EngineRunLimitsActivity(args: RunLimitsArgs): Promise<RunLimits>;
  EngineRecordEffortActivity(effort: RunEffort): Promise<void>;
  EngineSettleClaimsActivity(args: SettleClaimsArgs): Promise<string[]>;
}

export function createEngineActivities(services: EngineServices): EngineActivities {
  const treeAccess = async (treeId: string, ownerId: string) => {
    if (!services.treeWorkspaces) throw new Error('tree workspaces are not wired, so there is no worktree to prepare');
    if (!services.grove) throw new Error('grove stores are not wired, so the tree\'s leaves cannot be read');
    const shared = await services.treeWorkspaces.describe({ treeId, ownerId });
    const driver = await services.environments.forRun({
      ticket: { runId: `grove-${treeId}-prepare`, depth: 0, ownerId, agentSlug: 'grove-runner', trigger: 'user' },
      environment: { id: shared.id, spec: shared.capabilities, workspace: shared.workspace },
    });
    if (!driver) throw new Error('the tree sandbox could not be reached to prepare worktrees');
    return { driver, leaves: (await services.grove.leaves.list()).filter((leaf) => leaf.ownerId === ownerId) };
  };

  const adoption = (): PlanAdoption => {
    if (!services.planAdoption) throw new Error('plan adoption is not wired, so an approved plan cannot be built');
    return services.planAdoption;
  };

  return {
    ...createStreamActivities(services),

    async EngineResolveEnvironmentActivity(args: ResolveEnvironmentArgs): Promise<RunEnvironment> {
      return services.environments.describe(args.ticket);
    },

    async EngineReleaseEnvironmentActivity(args: ReleaseEnvironmentArgs): Promise<void> {
      await services.environments.release(args.ticket.runId);
    },

    async EngineResolveAgentActivity(args: ResolveAgentArgs): Promise<ResolvedAgentInfo> {
      const runnable = await services.registry.runnable(args.ownerId, args.agentSlug);
      if (!runnable) return { found: false, callableAgents: [] };

      const callable = await services.registry.callable(args.ownerId, args.agentSlug);

      return {
        found: true,
        tools: runnable.agent.tools,
        procedure: runnable.procedure,
        callableAgents: callable.map((agent) => agent.slug),
      };
    },

    async EngineToolActivity(args: ToolCallArgs): Promise<ToolCallOutcome> {
      return services.tools.run(args);
    },

    async EngineMergeActivity(args: MergeArgs): Promise<Record<string, unknown>> {
      return services.merges.run(args);
    },

    async GroveWorkspaceActivity(args: GroveWorkspaceArgs): Promise<TreeSandbox> {
      if (!services.treeWorkspaces) throw new Error('tree workspaces are not wired, so a grove run has nowhere to work');
      return services.treeWorkspaces.describe(args);
    },

    async GroveParkWorkspaceActivity(args: GroveWorkspaceArgs): Promise<void> {
      if (!services.treeWorkspaces) throw new Error('tree workspaces are not wired, so there is no pod to park');
      await services.treeWorkspaces.park(args.treeId);
    },

    async GrovePrepareWorkActivity(args) {
      const { driver, leaves } = await treeAccess(args.treeId, args.ownerId);
      const prepared: GrovePreparedWork = { ready: [], failed: [] };
      for (const leafId of args.leafIds) {
        const leaf = leaves.find((entry) => entry.id === leafId);
        if (!leaf) continue;
        const dependencies = (leaf.dependsOn ?? []).map((id) => {
          const commit = leaves.find((entry) => entry.id === id)?.claim?.commit;
          return { leafId: id, ...(commit ? { commit } : {}) };
        });
        try {
          await prepareLeafWorktree(driver, leafId, dependencies);
          prepared.ready.push(leafId);
        } catch (err) {
          if (!(err instanceof WorktreeConflictError)) throw err;
          const reason = `could not prepare its worktree: ${err.message}`;
          await services.grove?.leaves.save?.({ ...leaf, status: 'failed', findings: reason, updatedAt: new Date().toISOString() });
          prepared.failed.push({ leafId, reason });
        }
      }
      return prepared;
    },

    async GroveJudgeCheckoutActivity(args) {
      const { driver, leaves } = await treeAccess(args.treeId, args.ownerId);
      const checkouts: GroveJudgeCheckouts = {};
      for (const leafId of args.leafIds) {
        const commit = leaves.find((entry) => entry.id === leafId)?.claim?.commit;
        checkouts[leafId] = await prepareJudgeCheckout(driver, leafId, commit);
      }
      return checkouts;
    },

    async PlanAdoptRecordsActivity(args) {
      return adoption().records(args.ownerId, args.proposalId);
    },

    async PlanAdoptDocumentsActivity(args) {
      return adoption().documents(args.ownerId, args.proposalId, args.records);
    },

    async PlanAdoptSettleActivity(args) {
      await adoption().settle(args.ownerId, args.proposalId, {
        status: args.status,
        ...(args.adopted ? { adopted: args.adopted } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      });
    },

    async GrovePartitionActivity(args: GrovePartitionArgs): Promise<GrovePartition> {
      if (!services.grove) throw new Error('grove stores are not wired, so the grove partition cannot run');

      const readOnlySave = async (): Promise<void> => {
        throw new Error('the grove partition is read-only');
      };
      const tools = createGroveTools({
        stores: {
          trees: { list: services.grove.trees.list, save: readOnlySave },
          branches: { list: services.grove.branches.list, save: readOnlySave },
          leaves: { list: services.grove.leaves.list, save: readOnlySave },
          tasks: { list: services.grove.tasks.list },
        },
      });
      const outcome = await tools['ready_leaves']!({
        name: 'ready_leaves',
        parsed: { treeId: args.treeId },
        driver: undefined,
        caller: { ownerId: args.ownerId, runId: 'partition', agentSlug: 'grove-runner' },
      });
      if (!outcome.ok) throw new Error(`grove partition failed: ${outcome.digest}`);

      const parsed = JSON.parse(outcome.content ?? '{}') as {
        ready?: unknown[];
        claimed?: unknown[];
        awaitingReview?: unknown[];
        settled?: unknown[];
      };
      return {
        ready: (parsed.ready ?? []) as GrovePartition['ready'],
        claimed: (parsed.claimed ?? []) as GrovePartition['claimed'],
        awaitingReview: (parsed.awaitingReview ?? []) as GrovePartition['awaitingReview'],
        settledCount: (parsed.settled ?? []).length,
      };
    },

    EngineNodeActivity: createNodeRunner(services.hostNodes ?? [], services.bus),

    async EngineRecordTracesActivity(args: RecordTracesArgs): Promise<void> {
      await services.traces?.record(args);
    },

    async EngineRunLimitsActivity(args: RunLimitsArgs): Promise<RunLimits> {
      if (!services.effort) return { modelKey: UNRESOLVED_MODEL, modelLabel: 'no model', limits: { ...args.procedure.budget } };
      return services.effort.limits(args);
    },

    async EngineRecordEffortActivity(effort: RunEffort): Promise<void> {
      await services.effort?.record(effort);
    },

    async EngineSettleClaimsActivity(args: SettleClaimsArgs): Promise<string[]> {
      if (!services.tasks) return [];
      const ending = args.reason ? `${args.outcome} — ${args.reason}` : args.outcome;
      const abandoned = abandonedBy(await services.tasks.list(args.ownerId), args.runId, ending, new Date().toISOString());
      for (const task of abandoned) await services.tasks.save(task);
      return abandoned.map((task) => task.id);
    },
  };
}

export function createStreamActivities(services: StreamServices): StreamActivities {
  return {
    async EnginePublishActivity(args: PublishArgs): Promise<void> {
      for (const event of args.events) services.bus.emit(event);
    },

    EngineStreamNodeActivity: createNodeRunner(services.streamNodes ?? [], services.bus),
  };
}
