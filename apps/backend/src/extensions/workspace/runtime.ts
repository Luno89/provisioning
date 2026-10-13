import type { ExtensionRuntime } from '../types.js';
import { createWorkspaceOperations, type WorkspaceOperationDeps } from './operations/handlers.js';
import { createWorkspaceTools, type WorkspaceToolDeps } from './tools/handlers.js';

export interface WorkspaceRuntimeDeps {
  operations?: WorkspaceOperationDeps | undefined;
  tools?: WorkspaceToolDeps | undefined;
}

export const workspaceRuntime = (deps: WorkspaceRuntimeDeps): ExtensionRuntime => ({
  operations: deps.operations ? createWorkspaceOperations(deps.operations) : {},
  tools: deps.tools ? createWorkspaceTools(deps.tools) : {},
});
