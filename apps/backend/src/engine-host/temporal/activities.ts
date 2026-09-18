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
  EngineNodeActivity(request: RemoteNodeRequest): Promise<RemoteNodeResult>;
  EngineRecordTracesActivity(args: RecordTracesArgs): Promise<void>;
  EngineRunLimitsActivity(args: RunLimitsArgs): Promise<RunLimits>;
  EngineRecordEffortActivity(effort: RunEffort): Promise<void>;
  EngineSettleClaimsActivity(args: SettleClaimsArgs): Promise<string[]>;
}

export function createEngineActivities(services: EngineServices): EngineActivities {
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
