import { ApplicationFailure } from '@temporalio/common';
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
  type NodeCatalogue,
  type NodeImplementation,
  type NodeRequest,
} from '@koala/agent-engine/procedure';
import type {
  AdoptPlanArgs,
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
  ProcedureRunInput,
} from './contracts.js';
import { type LifecycleEvent, type BenchIdleOutcome, type ConcludeWorkspaceArgs, groveRunWorkflowId } from './contracts.js';
import type { ConversationWorkspaces } from '../sandboxes/conversation-workspaces.js';
import type { SavedDocuments } from '../sandboxes/workspace-documents.js';
import { DEFAULT_CHAT_AGENT } from '../../lib/conclusions.js';
import { type TreeTypeChoice } from '../../extensions/grove/tools/grove-tools.js';
import type { TreeWorkspaces } from '../sandboxes/tree-workspaces.js';
import type { AdoptedRecords, PlanAdoption } from '../plan-adoption.js';
import { groveAgentOf, resolveTreeType } from '../../lib/tree-types.js';

import type { AdoptedPlan } from '../../lib/plan-proposals.js';
import type { Tree } from '../../lib/trees.js';
import type { Branch, Leaf } from '../../lib/leaves.js';
import type { AgentRegistry } from '../registries/registry.js';
import type { EnvironmentResolver } from '../sandboxes/environments.js';
import { platformCatalogue } from '../../extensions/installed.js';

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
  runCancelled?: ((runId: string) => Promise<boolean>) | undefined;
  conclude?: ((event: LifecycleEvent) => Promise<void>) | undefined;
  benchIdle?: ((ownerId: string) => Promise<BenchIdleOutcome>) | undefined;
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
  conversationWorkspaces?: Pick<ConversationWorkspaces, 'conclude'> | undefined;
  /** The agent a conversation is held with, whose reach decides what its workspace was built for. */
  conversationAgent?: ((ownerId: string, conversationId: string) => Promise<string | undefined>) | undefined;
  planAdoption?: PlanAdoption | undefined;
  plans?: { list(ownerId: string): Promise<import('../../lib/plan-proposals.js').PlanProposal[]> } | undefined;
}

/** Read-side of a grove's stores: just enough for the ready-leaves partition. */
export interface GroveStores {
  trees: { list(): Promise<Tree[]> };
  branches: { list(): Promise<Branch[]> };
  leaves: { list(): Promise<Leaf[]>; save?(leaf: Leaf): Promise<void> };
  tasks: { list(): Promise<Task[]> };
  /** the tree types this owner can see, each with the agents it names for its stages */
  treeTypes?: ((ownerId: string) => Promise<TreeTypeChoice[]>) | undefined;
}

export interface StreamActivities {
  EnginePublishActivity(args: PublishArgs): Promise<void>;
  EngineStreamNodeActivity(request: RemoteNodeRequest): Promise<RemoteNodeResult>;
  EngineLifecycleActivity(event: LifecycleEvent): Promise<void>;
  EngineBenchIdleActivity(args: { ownerId: string }): Promise<BenchIdleOutcome>;
}

export const NODE_HEARTBEAT_MS = 10_000;

function currentActivity(): Context | undefined {
  try {
    return Context.current();
  } catch {
    return undefined;
  }
}

export const CANCEL_POLL_MS = 3_000;

export function createNodeRunner(
  implementations: readonly NodeImplementation[],
  bus: EventBus | undefined,
  options: { catalogue?: NodeCatalogue | undefined; runCancelled?: ((runId: string) => Promise<boolean>) | undefined } = {},
): (request: RemoteNodeRequest) => Promise<RemoteNodeResult> {
  const catalogue = options.catalogue ?? platformCatalogue();
  const byKind = new Map(implementations.map((implementation) => [implementation.kind, implementation]));

  return async (request) => {
    const implementation = byKind.get(request.node.kind);
    const definition = catalogue.get(request.node.kind);
    if (!implementation || !definition) {
      throw new Error(`this worker cannot run a "${request.node.kind}" node`);
    }

    const context = currentActivity();
    const stop = new AbortController();
    context?.cancellationSignal.addEventListener('abort', () => stop.abort('the run was cancelled'));
    const runId = request.run.identity.runId;
    const watching = options.runCancelled
      ? setInterval(() => {
        void options.runCancelled!(runId).then((cancelled) => { if (cancelled) stop.abort('the run was cancelled'); });
      }, CANCEL_POLL_MS)
      : undefined;
    const full: NodeRequest = {
      node: request.node,
      origin: request.origin,
      definition,
      inputs: request.inputs,
      ...(request.previous ? { previous: request.previous } : {}),
      execution: request.execution,
      run: {
        ...request.run,
        signal: stop.signal,
        emit: (event) => bus?.emit({ ...event, runId: request.run.identity.runId, at: new Date().toISOString() } as never),
      },
    };

    const beating = context ? setInterval(() => context.heartbeat(), NODE_HEARTBEAT_MS) : undefined;
    try {
      return await implementation.run(full);
    } finally {
      if (beating) clearInterval(beating);
      if (watching) clearInterval(watching);
    }
  };
}

export interface EngineActivities extends StreamActivities {
  EngineResolveEnvironmentActivity(args: ResolveEnvironmentArgs): Promise<RunEnvironment>;
  EngineReleaseEnvironmentActivity(args: ReleaseEnvironmentArgs): Promise<void>;
  EngineResolveAgentActivity(args: ResolveAgentArgs): Promise<ResolvedAgentInfo>;
  EngineToolActivity(args: ToolCallArgs): Promise<ToolCallOutcome>;
  EngineMergeActivity(args: MergeArgs): Promise<Record<string, unknown>>;
  GroveRunInputActivity(args: { treeId: string; ownerId: string }): Promise<ProcedureRunInput>;
  ConcludeWorkspaceActivity(args: ConcludeWorkspaceArgs): Promise<SavedDocuments>;
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
      return services.tools.run(args, currentActivity()?.info.attempt ?? 1);
    },

    async EngineMergeActivity(args: MergeArgs): Promise<Record<string, unknown>> {
      return services.merges.run(args);
    },

    async GroveRunInputActivity(args) {
      const tree = (await services.grove?.trees.list() ?? []).find((entry) => entry.id === args.treeId && entry.ownerId === args.ownerId);
      if (!tree) throw ApplicationFailure.nonRetryable(`there is no tree "${args.treeId}" to run`, 'GroveTreeMissing');
      const treeTypes = services.grove?.treeTypes;
      const type = treeTypes ? await resolveTreeType({ getTreeTypes: async () => treeTypes(args.ownerId) }, args.ownerId, tree.type) : undefined;
      const agentSlug = groveAgentOf(type);
      const runnable = await services.registry.runnable(args.ownerId, agentSlug);
      if (!runnable) throw ApplicationFailure.nonRetryable(`there is no agent called "${agentSlug}" to grow this tree`, 'GroveAgentMissing');
      return {
        ticket: { runId: groveRunWorkflowId(args.treeId), depth: 0, ownerId: args.ownerId, agentSlug, trigger: 'user' },
        procedure: runnable.procedure,
        inputs: { treeId: args.treeId, message: 'Grow the tree.' },
      };
    },

    async ConcludeWorkspaceActivity({ ownerId, workspace }) {
      if (workspace.kind === 'tree') {
        if (!services.treeWorkspaces) throw new Error('tree workspaces are not wired, so a tree\'s workspace cannot be concluded');
        return services.treeWorkspaces.release(workspace.id, ownerId);
      }
      if (!services.conversationWorkspaces) return { saved: false, why: 'this server keeps no conversation workspaces' };
      const agentSlug = (await services.conversationAgent?.(ownerId, workspace.id)) ?? DEFAULT_CHAT_AGENT;
      return services.conversationWorkspaces.conclude({ conversationId: workspace.id, ownerId, agentSlug });
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

    EngineNodeActivity: createNodeRunner(services.hostNodes ?? [], services.bus, { runCancelled: services.runCancelled }),

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
      const abandoned = abandonedBy(await services.tasks.list(args.ownerId), args.runId, args.outcome, ending, new Date().toISOString());
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

    EngineStreamNodeActivity: createNodeRunner(services.streamNodes ?? [], services.bus, { runCancelled: services.runCancelled }),

    async EngineLifecycleActivity(event: LifecycleEvent): Promise<void> {
      await services.conclude?.(event);
    },

    async EngineBenchIdleActivity({ ownerId }: { ownerId: string }): Promise<BenchIdleOutcome> {
      return (await services.benchIdle?.(ownerId)) ?? 'nothing';
    },
  };
}
