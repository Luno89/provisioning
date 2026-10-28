import { executeTool, refuse, type EnvironmentDriver, type ToolHandler, type ToolOutcome } from '@koala/engine-core';
import type { EnvironmentHandleRef, RunTicket, ToolCallArgs, ToolCallOutcome, ToolRuntime } from '../temporal/contracts.js';
import type { AgentRegistry } from '../registries/registry.js';
import type { ServerTools } from './server-tools.js';
import { isMcpToolName } from '../../engine/lib/mcp-tools.js';
import { placeArtifacts, treeOfWorkspace } from '../sandboxes/workspace-repos.js';
import { keptToProblem } from '../../engine/lib/acting-for.js';
import { accessOf, accessProblem, projectRefsIn, type ProjectResolution } from '../../engine/lib/tool-access.js';
import type { ProjectResolver } from '../../engine/index.js';
import { asPerson, memberPrincipal } from '../../platform/lib/permissions.js';

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
  serverTools?: ServerTools | undefined;
  resources?: ProjectResolver | undefined;
}

const argumentsOf = (text: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const placed = (outcome: ToolOutcome, args: ToolCallArgs): ToolCallOutcome => {
  const { artifacts, ...rest } = outcome;
  const kept = placeArtifacts(artifacts, args.environment);
  return { ...rest, ...(kept.length ? { artifacts: kept } : {}) };
};

export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  return {
    async run(args: ToolCallArgs, attempt = 1, signal?: AbortSignal): Promise<ToolCallOutcome> {
      const agent = await options.registry.agent(args.ticket.ownerId, args.ticket.agentSlug);
      if (!agent) return placed(refuse(`There is no agent called "${args.ticket.agentSlug}".`), args);
      if (args.ticket.keptTo) {
        const problem = keptToProblem(args.name, argumentsOf(args.arguments));
        if (problem) return placed(refuse(problem), args);
      }

      const driver = await options.environments?.forRun({
        ticket: args.ticket,
        ...(args.environment ? { environment: args.environment } : {}),
      });
      const registered = await options.registry.tools(args.ticket.ownerId);
      const served = options.serverTools && isMcpToolName(args.name)
        ? await options.serverTools.forRun({ ticket: args.ticket, environment: args.environment, held: agent.servers ?? [], ceiling: agent.maxEffect })
        : undefined;
      const catalogue = [...registered, ...(served?.tools ?? [])];
      const parsed = argumentsOf(args.arguments);
      const scope = {
        ...(args.ticket.projectId ? { projectId: args.ticket.projectId } : {}),
        ...(args.environment?.workspace && treeOfWorkspace(args.environment.workspace.runId) ? { treeId: treeOfWorkspace(args.environment.workspace.runId) } : {}),
        ...(args.ticket.conversationId ? { conversationId: args.ticket.conversationId } : {}),
      };
      const access = accessOf(args.name, catalogue.find((tool) => tool.name === args.name), isMcpToolName(args.name));
      const refs = projectRefsIn(parsed);
      const resolved: ProjectResolution = access.on === 'project'
        ? options.resources
          ? await options.resources.project(args.ticket.ownerId, refs, scope)
          : args.ticket.actingFor ? { outside: Object.keys(refs)[0] ?? 'project' } : {}
        : {};
      const problem = accessProblem(args.name, access, args.ticket.principal ?? (args.ticket.actingFor ? memberPrincipal(args.ticket.actingFor.personId, args.ticket.actingFor.projectId, args.ticket.actingFor.role) : asPerson(args.ticket.ownerId)), args.ticket.ownerId, parsed, resolved, args.ticket.actingFor);
      if (problem) return placed(refuse(problem), args);
      if (attempt > 1 && catalogue.find((tool) => tool.name === args.name)?.idempotent !== true) {
        return placed(refuse(`${args.name} may already have run once before this call failed, and running it again is not safe, so it was not repeated. Check what it did before calling it again.`), args);
      }

      const outcome = await executeTool({
        name: args.name,
        arguments: args.arguments,
        granted: [...(args.granted ?? agent.tools), ...(served?.tools.map((tool) => tool.name) ?? [])],
        catalogue,
        ...(agent.maxEffect ? { ceiling: agent.maxEffect } : {}),
        caller: {
          ownerId: args.ticket.ownerId,
          runId: args.ticket.runId,
          agentSlug: args.ticket.agentSlug,
          ...(args.ticket.conversationId ? { conversationId: args.ticket.conversationId } : {}),
          ...(args.ticket.projectId ? { projectId: args.ticket.projectId } : {}),
          ...(args.environment?.workspace?.sharedBy === 'conversation' ? { inConversationWorkspace: true } : {}),
          ...(args.environment?.workspace && treeOfWorkspace(args.environment.workspace.runId) ? { treeId: treeOfWorkspace(args.environment.workspace.runId) } : {}),
        },
        ...(driver ? { driver } : {}),
        ...(options.handlers || served ? { handlers: { ...(options.handlers ?? {}), ...(served?.handlers ?? {}) } } : {}),
        ...(options.digestChars === undefined ? {} : { digestChars: options.digestChars }),
        ...(signal ? { signal } : {}),
      });
      return placed(outcome, args);
    },
  };
}
