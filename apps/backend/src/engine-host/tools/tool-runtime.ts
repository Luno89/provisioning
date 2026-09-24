import { executeTool, refuse, type EnvironmentDriver, type ToolHandler } from '@koala/engine-core';
import type { EnvironmentHandleRef, RunTicket, ToolCallArgs, ToolCallOutcome, ToolRuntime } from '../temporal/contracts.js';
import type { AgentRegistry } from '../registries/registry.js';

export type { ToolHandler } from '@koala/engine-core';
export type { ToolRuntime } from '../temporal/contracts.js';

export interface EnvironmentSource {
  forRun(request: {
    ticket: RunTicket;
    environment?: EnvironmentHandleRef | undefined;
  }): Promise<EnvironmentDriver | undefined>;
}

export interface ToolRuntimeOptions {
  registry: AgentRegistry;
  environments?: EnvironmentSource | undefined;
  handlers?: Record<string, ToolHandler> | undefined;
  digestChars?: number | undefined;
}

export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  return {
    async run(args: ToolCallArgs): Promise<ToolCallOutcome> {
      const agent = await options.registry.agent(args.ticket.ownerId, args.ticket.agentSlug);
      if (!agent) return refuse(`There is no agent called "${args.ticket.agentSlug}".`);

      const driver = await options.environments?.forRun({
        ticket: args.ticket,
        ...(args.environment ? { environment: args.environment } : {}),
      });
      const catalogue = await options.registry.tools(args.ticket.ownerId);

      return executeTool({
        name: args.name,
        arguments: args.arguments,
        granted: agent.tools,
        catalogue,
        caller: {
          ownerId: args.ticket.ownerId,
          runId: args.ticket.runId,
          agentSlug: args.ticket.agentSlug,
          ...(args.ticket.conversationId ? { conversationId: args.ticket.conversationId } : {}),
        },
        ...(driver ? { driver } : {}),
        ...(options.handlers ? { handlers: options.handlers } : {}),
        ...(options.digestChars === undefined ? {} : { digestChars: options.digestChars }),
      });
    },
  };
}
