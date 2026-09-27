import { createProcedureTools, type ProcedureSourceStore, type ProcedureScope } from '../registries/procedure-tools.js';
import { createTaskTools, type TaskStore } from './task-tools.js';
import { createGroveTools, type GroveToolOptions } from './grove-tools.js';
import { createPlatformTools, type PlatformToolOptions } from './platform-tools.js';
import { createSecretTools, type SecretToolOptions } from './secret-tools.js';
import { createMcpRequestTools, type McpAccess, type McpToolStores } from './mcp-tools.js';
import { createKubeTools, type KubeAccess } from './kube-tools.js';
import { createProjectTools, type ProjectToolStores } from './project-tools.js';
import { createEgressTools, type EgressToolStores } from './egress-tools.js';
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
}

export function createEngineToolHandlers(deps: EngineToolDeps): Record<string, ToolHandler> {
  return {
    ...createProcedureTools({ store: deps.procedures, scope: deps.scope }),
    ...createTaskTools({ store: deps.tasks, binding: deps.groove?.stores.binding }),
    ...(deps.groove ? createGroveTools(deps.groove) : {}),
    ...createPlatformTools(deps.platform),
    ...(deps.secrets ? createSecretTools(deps.secrets) : {}),
    ...(deps.mcp ? createMcpRequestTools(deps.mcp) : {}),
    ...(deps.kube ? createKubeTools({ access: deps.kube }) : {}),
    ...(deps.projects ? createProjectTools({ stores: deps.projects }) : {}),
    ...(deps.egress ? createEgressTools({ stores: deps.egress }) : {}),
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
