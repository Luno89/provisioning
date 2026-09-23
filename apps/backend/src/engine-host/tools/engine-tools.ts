import { createProcedureTools, type ProcedureSourceStore, type ProcedureScope } from '../registries/procedure-tools.js';
import { createTaskTools, type TaskStore } from './task-tools.js';
import { createGroveTools, type GroveToolOptions } from './grove-tools.js';
import { createPlatformTools, type PlatformToolOptions } from './platform-tools.js';
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
}

export function createEngineToolHandlers(deps: EngineToolDeps): Record<string, ToolHandler> {
  return {
    ...createProcedureTools({ store: deps.procedures, scope: deps.scope }),
    ...createTaskTools({ store: deps.tasks }),
    ...(deps.groove ? createGroveTools(deps.groove) : {}),
    ...createPlatformTools(deps.platform),
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
