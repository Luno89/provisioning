import { executeTool, refuse, type EnvironmentDriver, type ToolHandler, type ToolOutcome } from '@koala/engine-core';
import type { EnvironmentHandleRef, RunTicket, ToolCallArgs, ToolCallOutcome, ToolRuntime } from '../temporal/contracts.js';
import type { AgentRegistry } from '../registries/registry.js';
import type { McpToolSource } from './mcp-tools.js';
import { isMcpToolName } from '../../lib/mcp-tools.js';
import { placeArtifacts } from '../sandboxes/workspace-repos.js';

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
  mcp?: McpToolSource | undefined;
}

const placed = (outcome: ToolOutcome, args: ToolCallArgs): ToolCallOutcome => {
  const { artifacts, ...rest } = outcome;
  const kept = placeArtifacts(artifacts, args.environment);
  return { ...rest, ...(kept.length ? { artifacts: kept } : {}) };
};

export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  return {
    async run(args: ToolCallArgs, attempt = 1): Promise<ToolCallOutcome> {
      const agent = await options.registry.agent(args.ticket.ownerId, args.ticket.agentSlug);
      if (!agent) return placed(refuse(`There is no agent called "${args.ticket.agentSlug}".`), args);

      const driver = await options.environments?.forRun({
        ticket: args.ticket,
        ...(args.environment ? { environment: args.environment } : {}),
      });
      const mcp = options.mcp && isMcpToolName(args.name)
        ? await options.mcp.forRun(args.ticket.ownerId, agent, args.ticket.conversationId)
        : undefined;
      const catalogue = [...await options.registry.tools(args.ticket.ownerId), ...(mcp?.contracts ?? [])];
      if (attempt > 1 && catalogue.find((tool) => tool.name === args.name)?.idempotent !== true) {
        return placed(refuse(`${args.name} may already have run once before this call failed, and running it again is not safe, so it was not repeated. Check what it did before calling it again.`), args);
      }

      const outcome = await executeTool({
        name: args.name,
        arguments: args.arguments,
        granted: [...agent.tools, ...(mcp?.contracts.map((tool) => tool.name) ?? [])],
        catalogue,
        ...(agent.maxEffect ? { ceiling: agent.maxEffect } : {}),
        caller: {
          ownerId: args.ticket.ownerId,
          runId: args.ticket.runId,
          agentSlug: args.ticket.agentSlug,
          ...(args.ticket.conversationId ? { conversationId: args.ticket.conversationId } : {}),
          ...(args.ticket.projectId ? { projectId: args.ticket.projectId } : {}),
          ...(args.environment?.workspace?.sharedBy === 'conversation' ? { inConversationWorkspace: true } : {}),
        },
        ...(driver ? { driver } : {}),
        ...(options.handlers || mcp ? { handlers: { ...(options.handlers ?? {}), ...(mcp?.handlers ?? {}) } } : {}),
        ...(options.digestChars === undefined ? {} : { digestChars: options.digestChars }),
      });
      return placed(outcome, args);
    },
  };
}
