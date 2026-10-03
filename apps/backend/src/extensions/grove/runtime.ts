import type { ExtensionRuntime } from '../types.js';
import { createGroveOperations, type GroveOperationDeps } from './operations/handlers.js';
import { createGroveTools, type GroveToolOptions } from './tools/grove-tools.js';

export interface GroveRuntimeDeps {
  operations?: GroveOperationDeps | undefined;
  tools?: GroveToolOptions | undefined;
}

export const groveRuntime = (deps: GroveRuntimeDeps): ExtensionRuntime => ({
  operations: deps.operations ? createGroveOperations(deps.operations) : {},
  tools: deps.tools ? createGroveTools(deps.tools) : {},
});
