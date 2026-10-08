import type { AgentDefinition } from '@koala/agent-engine';
import type { RunEnvironment, RunTicket } from '../temporal/contracts.js';
import { NothingToShareError, type EnvironmentResolver } from './environments.js';
import { destroyWorkspace, workspaceRunning, type KubeRunner } from './kube.js';
import { POD, workspaceName } from './workspace.js';
import type { SavedDocuments, WorkspaceDocuments } from './workspace-documents.js';
import { conversationWorkspaceRunId, repoForWorkspace } from './workspace-repos.js';

export type ConversationSandbox = Extract<RunEnvironment, { kind: 'sandbox' }>;

export interface ConversationWorkspaceRequest {
  conversationId: string;
  ownerId: string;
  agentSlug: string;
}

export interface ConversationWorkspaces {
  describe(request: ConversationWorkspaceRequest): Promise<ConversationSandbox | undefined>;
  state(conversationId: string): Promise<'none' | 'running' | 'parked'>;
  save(request: { conversationId: string; ownerId: string }): Promise<SavedDocuments>;
  conclude(request: ConversationWorkspaceRequest): Promise<SavedDocuments>;
}

export async function reachableAgents(
  registry: { agent(ownerId: string, slug: string): Promise<AgentDefinition | undefined> },
  ownerId: string,
  slug: string,
): Promise<string[]> {
  const seen = new Set<string>([slug]);
  const queue = [slug];
  while (queue.length > 0) {
    const agent = await registry.agent(ownerId, queue.shift()!);
    for (const next of agent?.agents ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen];
}

export function createConversationWorkspaces(options: {
  resolver: EnvironmentResolver;
  registry: { agent(ownerId: string, slug: string): Promise<AgentDefinition | undefined> };
  kube: KubeRunner;
  documents: WorkspaceDocuments;
}): ConversationWorkspaces {
  const ticketFor = (request: ConversationWorkspaceRequest): RunTicket => ({
    runId: conversationWorkspaceRunId(request.conversationId),
    depth: 0,
    ownerId: request.ownerId,
    agentSlug: request.agentSlug,
    trigger: 'user',
  });

  const describe = async (request: ConversationWorkspaceRequest): Promise<ConversationSandbox | undefined> => {
    try {
      const shared = await options.resolver.describeShared({
        ticket: ticketFor(request),
        agents: await reachableAgents(options.registry, request.ownerId, request.agentSlug),
      });
      return { ...shared, workspace: { ...shared.workspace, sharedBy: 'conversation' } };
    } catch (err) {
      if (err instanceof NothingToShareError) return undefined;
      throw err;
    }
  };

  return {
    describe,

    async state(conversationId) {
      const namespace = workspaceName(conversationWorkspaceRunId(conversationId));
      if ((await options.kube(['get', 'namespace', namespace, '-o', 'name'], undefined, 15_000)).exitCode !== 0) return 'none';
      return (await workspaceRunning(options.kube, namespace, POD).catch(() => false)) ? 'running' : 'parked';
    },

    save: ({ conversationId, ownerId }) => {
      const workspaceRunId = conversationWorkspaceRunId(conversationId);
      return options.documents.save({ ownerId, workspaceRunId, ...repoForWorkspace(workspaceRunId)! });
    },

    async conclude(request) {
      const workspaceRunId = conversationWorkspaceRunId(request.conversationId);
      const namespace = workspaceName(workspaceRunId);
      const exists = (await options.kube(['get', 'namespace', namespace, '-o', 'name'], undefined, 15_000)).exitCode === 0;
      if (!exists) return { saved: false, why: 'nothing ever ran in this conversation\'s workspace' };

      if (!(await workspaceRunning(options.kube, namespace, POD).catch(() => false))) {
        const shared = await describe(request);
        if (!shared) throw new Error(`the workspace of conversation ${request.conversationId} is stopped and could not be described to start it again`);
        const driver = await options.resolver.forRun({
          ticket: ticketFor(request),
          environment: { id: shared.id, spec: shared.capabilities, workspace: shared.workspace },
        });
        await driver?.exec({ command: 'true', timeoutMs: 60_000 });
      }

      const saved = await options.documents.save({ ownerId: request.ownerId, workspaceRunId, ...repoForWorkspace(workspaceRunId)! });
      if (!saved.saved && !saved.empty) throw new Error(`the workspace of conversation ${request.conversationId} was kept, because it could not be saved: ${saved.why}`);
      await destroyWorkspace(options.kube, namespace);
      return saved;
    },
  };
}
