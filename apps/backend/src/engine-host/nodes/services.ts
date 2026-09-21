import type { AgentDefinition, Monitor } from '@koala/agent-engine';
import type { NodeRequest } from '@koala/agent-engine/procedure';
import type { ToolContract } from '@koala/engine-core';
import type { AgentRegistry } from '../registries/registry.js';
import type { ModelServiceLike } from '../registries/endpoints.js';
import type { RunEnvironment, RunTicket, ToolRuntime } from '../temporal/contracts.js';
import type { MemoryItem } from '../drivers/memory-store.js';

export interface HostNodeServices {
  registry: Pick<AgentRegistry, 'agent' | 'callable' | 'tools'>;
  models: ModelServiceLike;
  tools: ToolRuntime;
  environments: {
    describe(ticket: RunTicket, wallClockLimitMs?: number | undefined): Promise<RunEnvironment>;
    release(runId: string): Promise<void>;
  };
  memories: {
    list(ownerId: string): Promise<MemoryItem[]>;
    save(item: MemoryItem): Promise<void>;
  };
  code?: import('./code-runner.js').CodeRunner | undefined;
  conversations: import('./conversation-nodes.js').ConversationStore;
  images?: { waiting(ownerId: string, agentSlug: string): Promise<string | undefined> } | undefined;
  efforts?: {
    replyCeiling(args: { ownerId: string; procedureId: string; modelKey: string; agentSlug: string }): Promise<number | undefined>;
  } | undefined;
  streamMonitors?: ((request: NodeRequest) => Monitor[]) | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}

export type { AgentDefinition, ToolContract };

export { ticketFor, handleFor } from '../temporal/contracts.js';
