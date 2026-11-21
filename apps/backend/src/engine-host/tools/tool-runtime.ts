import { executeTool, refuse, toolArgumentsOf, type EnvironmentDriver, type ToolHandler, type ToolOutcome } from '@koala/engine-core';
import type { EnvironmentHandleRef, RunPlace, ToolCallArgs, ToolCallOutcome, ToolRuntime } from '../temporal/contracts.js';
import type { AgentRegistry } from '../registries/registry.js';
import type { ServerTools } from './server-tools.js';
import { isMcpToolName } from '../../engine/lib/mcp-tools.js';
import { placeArtifacts, treeOfWorkspace } from '../sandboxes/workspace-repos.js';
import { accessOf, accessProblem, projectRefsIn, sourceOf, type ProjectResolution } from '../../engine/lib/tool-access.js';
import type { PoisoningWatch } from './poisoning-watch.js';
import { noGrantProblem, type GrantCheck, type ProjectResolver } from '../../engine/index.js';
import { withoutHidden } from '../../engine/lib/hidden-text.js';

export type { ToolHandler } from '@koala/engine-core';
export type { ToolRuntime } from '../temporal/contracts.js';

export interface EnvironmentSource {
  forRun(request: {
    ticket: RunPlace;
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
  grants: { check(grantId: string, tool: string, projectId: string | undefined): Promise<GrantCheck> };
  watch?: Pick<PoisoningWatch, 'beforeCall' | 'afterCall'> | undefined;
}

export function shownToTheModel(outcome: ToolOutcome): { outcome: ToolOutcome; removed: number } {
  const content = outcome.content === undefined ? undefined : withoutHidden(outcome.content);
  const digest = withoutHidden(outcome.digest);
  const removed = (content?.removed ?? 0) + digest.removed;
  if (!removed) return { outcome, removed: 0 };
  return {
    outcome: { ...outcome, digest: `${digest.text} [hidden characters removed: ${content?.removed ?? digest.removed}]`, ...(content ? { content: content.text } : {}) },
    removed: content?.removed ?? digest.removed,
  };
}

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
      const read = toolArgumentsOf(args.name, args.arguments);
      if ('problem' in read) return placed(refuse(read.problem), args);
      const parsed = read.args;
      const mcp = isMcpToolName(args.name);
      await options.watch?.beforeCall(args, parsed, mcp);

      const driver = await options.environments?.forRun({
        ticket: args.ticket,
        ...(args.environment ? { environment: args.environment } : {}),
      });
      const registered = await options.registry.tools(args.ticket.ownerId);
      const served = options.serverTools && isMcpToolName(args.name)
        ? await options.serverTools.forRun({ ticket: args.ticket, environment: args.environment, held: agent.servers ?? [], ceiling: agent.maxEffect })
        : undefined;
      const catalogue = [...registered, ...(served?.tools ?? [])];
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
          : {}
        : {};
      const checked: GrantCheck = args.ticket.grantId ? await options.grants.check(args.ticket.grantId, args.name, resolved.project?.id) : { problem: noGrantProblem(args.name) };
      if ('problem' in checked) return placed(refuse(checked.problem), args);
      const problem = accessProblem(args.name, access, checked.principal, args.ticket.ownerId, parsed, resolved);
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
      const shown = shownToTheModel(outcome);
      if (shown.outcome.ok) await options.watch?.afterCall(args, parsed, sourceOf(args.name, mcp), shown.outcome, shown.removed);
      return placed(shown.outcome, args);
    },
  };
}
