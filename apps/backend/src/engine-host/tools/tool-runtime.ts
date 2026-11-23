import { executeTool, refuse, toolArgumentsOf, type EnvironmentDriver, type ToolContract, type ToolHandler, type ToolOutcome } from '@koala/engine-core';
import type { AgentDefinition } from '@koala/agent-engine';
import type { EnvironmentHandleRef, RunPlace, ToolCallArgs, ToolCallOutcome, ToolRuntime } from '../temporal/contracts.js';
import type { AgentRegistry } from '../registries/registry.js';
import type { OfferedServerTools, ServerTools } from './server-tools.js';
import { checkedCall, type Checked } from '../../engine/lib/checked-call.js';
import { isMcpToolName } from '../../engine/lib/mcp-tools.js';
import { placeArtifacts, treeOfWorkspace } from '../sandboxes/workspace-repos.js';
import { accessOf, accessProblem, projectRefsIn, sourceOf, type ProjectResolution } from '../../engine/lib/tool-access.js';
import type { PoisoningWatch } from './poisoning-watch.js';
import { HANDOVER_TOOL, noGrantProblem, type GrantCheck, type ProjectResolver } from '../../engine/index.js';
import { callNeedsAsking } from '@koala/agent-engine/procedure';
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

export function shownToTheModel<T extends Pick<ToolOutcome, 'digest' | 'content'>>(outcome: T): { outcome: T; removed: number } {
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

interface Ready {
  agent: AgentDefinition;
  parsed: Readonly<Record<string, unknown>>;
  mcp: boolean;
  catalogue: ToolContract[];
  contract: ToolContract | undefined;
  served: OfferedServerTools | undefined;
}

export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  const check = async (args: ToolCallArgs): Promise<Checked<Ready, ToolCallOutcome>> => {
    const agent = await options.registry.agent(args.ticket.ownerId, args.ticket.agentSlug);
    if (!agent) return { refused: placed(refuse(`There is no agent called "${args.ticket.agentSlug}".`), args) };
    const read = toolArgumentsOf(args.name, args.arguments);
    if ('problem' in read) return { refused: placed(refuse(read.problem), args) };
    const parsed = read.args;
    const mcp = isMcpToolName(args.name);
    await options.watch?.beforeCall(args, parsed, mcp);

    const registered = await options.registry.tools(args.ticket.ownerId);
    const served = options.serverTools && mcp
      ? await options.serverTools.forRun({ ticket: args.ticket, environment: args.environment, held: agent.servers ?? [], ceiling: agent.maxEffect })
      : undefined;
    const catalogue = [...registered, ...(served?.tools ?? [])];
    const scope = {
      ...(args.ticket.projectId ? { projectId: args.ticket.projectId } : {}),
      ...(args.environment?.workspace && treeOfWorkspace(args.environment.workspace.runId) ? { treeId: treeOfWorkspace(args.environment.workspace.runId) } : {}),
      ...(args.ticket.conversationId ? { conversationId: args.ticket.conversationId } : {}),
    };
    const contract = catalogue.find((tool) => tool.name === args.name);
    const access = accessOf(args.name, contract, mcp);
    const refs = projectRefsIn(parsed);
    const resolved: ProjectResolution = access.on === 'project'
      ? options.resources
        ? await options.resources.project(args.ticket.ownerId, refs, scope)
        : {}
      : {};
    const checked: GrantCheck = args.ticket.grantId ? await options.grants.check(args.ticket.grantId, args.name, resolved.project?.id) : { problem: noGrantProblem(args.name) };
    if ('problem' in checked) return { refused: placed(refuse(checked.problem), args) };
    const problem = accessProblem(args.name, access, checked.principal, args.ticket.ownerId, parsed, resolved);
    if (problem) return { refused: placed(refuse(problem), args) };
    const where = args.environment ? { kind: args.environment.spec.kind } as Parameters<typeof callNeedsAsking>[1]['environment'] : undefined;
    if (!args.approved && callNeedsAsking(args.name, { offered: contract ? [contract] : [], environment: where })) {
      return { refused: { ok: false, digest: `${args.name} waits for a person to allow it`, asks: true } };
    }
    return { ready: { agent, parsed, mcp, catalogue, contract, served } };
  };

  const seen = async (args: ToolCallArgs, parsed: Readonly<Record<string, unknown>>, mcp: boolean, outcome: ToolCallOutcome): Promise<ToolCallOutcome> => {
    const shown = shownToTheModel(outcome);
    if (shown.outcome.ok) await options.watch?.afterCall(args, parsed, sourceOf(args.name, mcp), shown.outcome, shown.removed);
    return shown.outcome;
  };

  return {
    async check(args: ToolCallArgs): Promise<ToolCallOutcome | undefined> {
      const checked = await check(args);
      return 'refused' in checked ? checked.refused : undefined;
    },

    async shown(args: ToolCallArgs, outcome: ToolCallOutcome): Promise<ToolCallOutcome> {
      const read = toolArgumentsOf(args.name, args.arguments);
      if ('problem' in read) return placed(refuse(read.problem), args);
      return seen(args, read.args, isMcpToolName(args.name), outcome);
    },

    async run(args: ToolCallArgs, attempt = 1, signal?: AbortSignal): Promise<ToolCallOutcome> {
      return checkedCall<Ready, ToolCallOutcome>({
        check: () => check(args),
        run: async ({ agent, catalogue, contract, served }) => {
          if (attempt > 1 && contract?.idempotent !== true) {
            return placed(refuse(`${args.name} may already have run once before this call failed, and running it again is not safe, so it was not repeated. Check what it did before calling it again.`), args);
          }
          const driver = await options.environments?.forRun({
            ticket: args.ticket,
            ...(args.environment ? { environment: args.environment } : {}),
          });
          return placed(await executeTool({
            name: args.name,
            arguments: args.arguments,
            granted: [...(args.granted ?? agent.tools).filter((tool) => agent.tools.includes(tool) || tool === HANDOVER_TOOL), ...(served?.tools.map((tool) => tool.name) ?? [])],
            catalogue,
            ...(agent.maxEffect ? { ceiling: agent.maxEffect } : {}),
            caller: {
              ownerId: args.ticket.ownerId,
              runId: args.ticket.runId,
              grantId: args.ticket.grantId,
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
          }), args);
        },
        shown: (ran, ready) => seen(args, ready.parsed, ready.mcp, ran),
      });
    },
  };
}
