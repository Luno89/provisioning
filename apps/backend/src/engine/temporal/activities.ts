import { callModel, type EngineEndpoint } from '../model-call.js';
import { createMonitorSet, overthinkMonitor, type Monitor } from '../monitors.js';
import { composeContext, type ComposedContext, type ResolvedEnvironment } from '../context.js';
import { environmentFor } from '../agent.js';
import { capabilitiesOf, toolSchemas } from '@koala/engine-core';
import { createRunState } from '../run.js';
import type { EventBus } from '../events.js';
import type {
  MergeArgs,
  MergeRuntime,
  ModelCallArgs,
  ModelCallOutcome,
  PublishArgs,
  ReleaseEnvironmentArgs,
  ResolveAgentArgs,
  ResolvedAgentInfo,
  ResolveEnvironmentArgs,
  RunEnvironment,
  ToolCallArgs,
  ToolCallOutcome,
  ToolRuntime,
} from './contracts.js';
import type { AgentRegistry } from '../adapters/registry.js';
import type { EnvironmentResolver } from '../adapters/environments.js';

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
  streamMonitors?: ((args: ModelCallArgs) => Monitor[]) | undefined;
}

export interface EngineServices extends StreamServices {
  tools: ToolRuntime;
  merges: MergeRuntime;
  environments: EnvironmentResolver;
}

export interface StreamActivities {
  EngineModelCallActivity(args: ModelCallArgs): Promise<ModelCallOutcome>;
  EnginePublishActivity(args: PublishArgs): Promise<void>;
}

export interface EngineActivities extends StreamActivities {
  EngineResolveEnvironmentActivity(args: ResolveEnvironmentArgs): Promise<RunEnvironment>;
  EngineReleaseEnvironmentActivity(args: ReleaseEnvironmentArgs): Promise<void>;
  EngineResolveAgentActivity(args: ResolveAgentArgs): Promise<ResolvedAgentInfo>;
  EngineToolActivity(args: ToolCallArgs): Promise<ToolCallOutcome>;
  EngineMergeActivity(args: MergeArgs): Promise<Record<string, unknown>>;
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
        graph: runnable.graph,
        budget: runnable.agent.budget,
        callableAgents: callable.map((agent) => agent.slug),
      };
    },

    async EngineToolActivity(args: ToolCallArgs): Promise<ToolCallOutcome> {
      return services.tools.run(args);
    },

    async EngineMergeActivity(args: MergeArgs): Promise<Record<string, unknown>> {
      return services.merges.run(args);
    },
  };
}

async function composeForCall(
  services: StreamServices,
  args: ModelCallArgs,
): Promise<ComposedContext | undefined> {
  const agent = await services.registry.agent(args.ticket.ownerId, args.ticket.agentSlug);
  if (!agent) return undefined;

  const environment = args.environment ?? { kind: 'none' as const, egress: false };

  const resolved: ResolvedEnvironment = environment.kind === 'sandbox'
    ? { kind: 'sandbox', workspace: environment.workspace }
    : environment.kind === 'machine'
      ? {
        kind: 'machine',
        deviceName: environment.deviceName,
        root: environment.path ?? '.',
        egressMode: environment.egressMode,
      }
      : {
        kind: 'none',
        egress: environment.egress,
        ...(environment.bases ? { bases: environment.bases } : {}),
      };

  return composeContext({
    agent,
    environment: resolved,
    capabilities: environment.kind === 'sandbox'
      ? capabilitiesOf(environment.capabilities)
      : capabilitiesOf(environmentFor(agent)),
    catalogue: await services.registry.tools(args.ticket.ownerId),
    callable: await services.registry.callable(args.ticket.ownerId, args.ticket.agentSlug),
    allowed: args.tools,
  });
}

export function createStreamActivities(services: StreamServices): StreamActivities {
  return {
    async EngineModelCallActivity(args: ModelCallArgs): Promise<ModelCallOutcome> {
      const { endpoint, sampling, maxTokens } = await services.endpoints.forAgent({
        ownerId: args.ticket.ownerId,
        agentSlug: args.ticket.agentSlug,
        ...(args.modelId ? { modelId: args.modelId } : {}),
      });

      const composed = await composeForCall(services, args);

      const monitors = createMonitorSet(
        services.streamMonitors?.(args) ?? [overthinkMonitor({ seed: args.messages.at(-1)?.content ?? '' })],
      );
      const state = createRunState();

      const result = await callModel(
        {
          endpoint,
          messages: composed ? [{ role: 'system', content: composed.text }, ...args.messages] : args.messages,
          ...(composed && composed.tools.length > 0 ? { tools: toolSchemas(composed.tools) } : {}),
          maxTokens: args.maxTokens ?? maxTokens,
          ...(sampling ? { sampling } : {}),
          ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
          ...(args.toolChoice ? { toolChoice: args.toolChoice } : {}),
        },
        (event) => {
          if (event.kind === 'thinking') {
            services.bus.emit({
              type: 'thinking',
              runId: args.ticket.runId,
              at: new Date().toISOString(),
              nodeId: args.nodeId,
              delta: event.text,
            });
          }
          if (event.kind === 'content') {
            services.bus.emit({
              type: 'content',
              runId: args.ticket.runId,
              at: new Date().toISOString(),
              nodeId: args.nodeId,
              delta: event.text,
            });
          }
          return monitors.sink({ state })(event);
        },
      );

      return {
        content: result.content,
        thinking: result.thinking,
        toolCalls: result.toolCalls,
        finishReason: result.finishReason,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.interrupted ? { interrupted: result.interrupted } : {}),
      };
    },

    async EnginePublishActivity(args: PublishArgs): Promise<void> {
      for (const event of args.events) services.bus.emit(event);
    },
  };
}
