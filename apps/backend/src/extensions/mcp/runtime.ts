import type { ExtensionRuntime } from '../types.js';
import { createMcpOperations, type McpOperationDeps } from './operations/handlers.js';

export interface McpRuntimeDeps {
  operations?: McpOperationDeps | undefined;
}

export const mcpRuntime = (deps: McpRuntimeDeps): ExtensionRuntime => ({
  operations: deps.operations ? createMcpOperations(deps.operations) : {},
  tools: {},
});
