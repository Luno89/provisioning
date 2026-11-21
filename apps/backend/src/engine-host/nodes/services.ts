import type { AgentDefinition, Monitor } from '@koala/agent-engine';
import type { NodeRequest } from '@koala/agent-engine/procedure';
import type { ToolContract } from '@koala/engine-core';
import type { AgentRegistry } from '../registries/registry.js';
import type { ModelServiceLike } from '../registries/endpoints.js';
import type { RunEnvironment, RunPlace, ToolRuntime } from '../temporal/contracts.js';
import type { MemoryToolStore } from '../tools/memory-tools.js';
import type { Principal } from '../../platform/index.js';
import type { HandOffChecks } from '../tools/hand-offs.js';

export interface HostNodeServices {
  registry: Pick<AgentRegistry, 'agent' | 'callable' | 'tools'>;
  models: ModelServiceLike;
  tools: ToolRuntime;
  grants: { grant(id: string): Promise<{ principal: Principal } | undefined> } & HandOffChecks['grants'];
  environments: {
    describe(ticket: RunPlace, wallClockLimitMs?: number | undefined): Promise<RunEnvironment>;
    release(runId: string): Promise<void>;
  };
  memories: MemoryToolStore;
  code?: import('./code-runner.js').CodeRunner | undefined;
  conversations: import('./conversation-nodes.js').ConversationStore;
  conversationWorkspaces?: Pick<import('../sandboxes/conversation-workspaces.js').ConversationWorkspaces, 'describe' | 'save'> | undefined;
  serverTools?: import('../tools/server-tools.js').ServerTools | undefined;
  images?: { waiting(ownerId: string, agentSlug: string): Promise<string | undefined> } | undefined;
  streamMonitors?: ((request: NodeRequest) => Monitor[]) | undefined;
  operations?: Readonly<Record<string, import('../../extensions/types.js').HostOperationRun>> | undefined;
  hidden?: ((ownerId: string) => Promise<import('../../engine/index.js').HiddenVocabulary>) | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}

export type { AgentDefinition, ToolContract };

export { ticketFor, handleFor } from '../temporal/contracts.js';
