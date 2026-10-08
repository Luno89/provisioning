import type { ExtensionRuntime, HostOperationRun } from './types.js';
import type { ToolHandler } from '@koala/engine-core';
import { HOST_OPERATIONS } from './installed.js';
import { groveRuntime, type GroveRuntimeDeps } from './grove/runtime.js';
import { platformRuntime, type PlatformRuntimeDeps } from './platform/runtime.js';

export interface ExtensionRuntimeDeps {
  grove?: GroveRuntimeDeps | undefined;
  platform?: PlatformRuntimeDeps | undefined;
}

export function extensionRuntimes(deps: ExtensionRuntimeDeps): Record<string, ExtensionRuntime> {
  return { platform: platformRuntime(deps.platform ?? {}), grove: groveRuntime(deps.grove ?? {}) };
}

export const operationHandlers = (runtimes: Record<string, ExtensionRuntime>): Record<string, HostOperationRun> =>
  Object.assign({}, ...Object.values(runtimes).map((runtime) => runtime.operations));

export const toolHandlers = (runtimes: Record<string, ExtensionRuntime>): Record<string, ToolHandler> =>
  Object.assign({}, ...Object.values(runtimes).map((runtime) => runtime.tools));

export function unhandledOperations(handlers: Readonly<Record<string, HostOperationRun>>): string[] {
  return HOST_OPERATIONS.map((operation) => operation.name).filter((name) => !handlers[name]).sort();
}
