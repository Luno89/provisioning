import type { ExtensionRuntime, HostOperationRun } from './types.js';
import type { ToolHandler } from '@koala/engine-core';
import { HOST_OPERATIONS } from './installed.js';
import { groveRuntime, type GroveRuntimeDeps } from './grove/runtime.js';

export interface ExtensionRuntimeDeps {
  grove?: GroveRuntimeDeps | undefined;
}

export function extensionRuntimes(deps: ExtensionRuntimeDeps): Record<string, ExtensionRuntime> {
  return { grove: groveRuntime(deps.grove ?? {}) };
}

export const operationHandlers = (runtimes: Record<string, ExtensionRuntime>): Record<string, HostOperationRun> =>
  Object.assign({}, ...Object.values(runtimes).map((runtime) => runtime.operations));

export const toolHandlers = (runtimes: Record<string, ExtensionRuntime>): Record<string, ToolHandler> =>
  Object.assign({}, ...Object.values(runtimes).map((runtime) => runtime.tools));

export function unhandledOperations(handlers: Readonly<Record<string, HostOperationRun>>): string[] {
  return HOST_OPERATIONS.map((operation) => operation.name).filter((name) => !handlers[name]).sort();
}
