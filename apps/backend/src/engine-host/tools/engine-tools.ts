import { createProcedureTools, type ProcedureSourceStore, type ProcedureScope } from '../registries/procedure-tools.js';
import { createTaskTools, type TaskStore } from './task-tools.js';
import type { GroveToolOptions } from '../../extensions/grove/tools/grove-tools.js';
import { extensionRuntimes, toolHandlers } from '../../extensions/runtime.js';
import { createPlatformTools, type PlatformToolOptions } from './platform-tools.js';
import { createSecretTools, type SecretToolOptions } from './secret-tools.js';
import { createMcpRequestTools, type McpAccess, type McpToolStores } from './mcp-tools.js';
import { createKubeTools, type KubeAccess } from './kube-tools.js';
import { createProjectTools, type ProjectToolStores } from './project-tools.js';
import { createEgressTools, type EgressToolStores } from './egress-tools.js';
import { createCorpusTools, type CorpusAccess } from './corpus-tools.js';
import { createRunTools, type RunReader } from './run-tools.js';
import { createMemoryTools, type MemoryToolStore } from './memory-tools.js';
import { createScenarioTools, type ScenarioProposalAccess } from './scenario-tools.js';
import { createAgentChangeTools, type AgentChangeAccess } from './agent-change-tools.js';
import type { AgentRegistry } from '../registries/registry.js';
import type { ImageBuilder } from '../sandboxes/image-builder.js';
import type { ToolDefinition } from '@koala/agent-engine';
import type { ToolHandler } from '@koala/engine-core';

export interface EngineToolDeps {
  registry: AgentRegistry;
  images: ImageBuilder;
  catalogue: ToolDefinition[];
  procedures: ProcedureSourceStore;
  scope: ProcedureScope;
  tasks: TaskStore;
  groove?: GroveToolOptions | undefined;
  platform: PlatformToolOptions;
  secrets?: SecretToolOptions | undefined;
  mcp?: { access: McpAccess; stores: McpToolStores } | undefined;
  kube?: KubeAccess | undefined;
  projects?: ProjectToolStores | undefined;
  egress?: EgressToolStores | undefined;
  corpus?: CorpusAccess | undefined;
  runs?: RunReader | undefined;
  memories?: MemoryToolStore | undefined;
  scenarios?: ScenarioProposalAccess | undefined;
  agentChanges?: AgentChangeAccess | undefined;
}

export function createEngineToolHandlers(deps: EngineToolDeps): Record<string, ToolHandler> {
  return {
    ...createProcedureTools({ store: deps.procedures, scope: deps.scope }),
    ...createTaskTools({ store: deps.tasks, binding: deps.groove?.stores.binding }),
    ...toolHandlers(extensionRuntimes({ grove: { tools: deps.groove } })),
    ...createPlatformTools(deps.platform),
    ...(deps.secrets ? createSecretTools(deps.secrets) : {}),
    ...(deps.mcp ? createMcpRequestTools(deps.mcp) : {}),
    ...(deps.kube ? createKubeTools({ access: deps.kube }) : {}),
    ...(deps.projects ? createProjectTools({ stores: deps.projects }) : {}),
    ...(deps.egress ? createEgressTools({ stores: deps.egress }) : {}),
    ...(deps.corpus ? createCorpusTools({ access: deps.corpus }) : {}),
    ...(deps.runs ? createRunTools({ runs: deps.runs }) : {}),
    ...(deps.memories ? createMemoryTools({ store: deps.memories, agents: async (ownerId) => (await deps.registry.agents(ownerId)).map((agent) => agent.slug) }) : {}),
    ...(deps.scenarios ? createScenarioTools(deps.scenarios) : {}),
    ...(deps.agentChanges ? createAgentChangeTools(deps.agentChanges) : {}),
  };
}

export function undeclaredHandlers(
  handlers: Record<string, ToolHandler>,
  catalogue: readonly ToolDefinition[],
): string[] {
  const declared = new Set(catalogue.map((tool) => tool.name));
  return Object.keys(handlers).filter((name) => !declared.has(name)).sort();
}

export function unimplemented(
  handlers: Record<string, ToolHandler>,
  catalogue: readonly ToolDefinition[],
): string[] {
  return catalogue.map((tool) => tool.name).filter((name) => !handlers[name]).sort();
}
