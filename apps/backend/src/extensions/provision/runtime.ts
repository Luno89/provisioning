import type { ExtensionRuntime } from '../types.js';
import { createProvisionOperations, type ProvisionOperationDeps } from './operations/handlers.js';

export interface ProvisionRuntimeDeps {
  operations?: ProvisionOperationDeps | undefined;
}

export const provisionRuntime = (deps: ProvisionRuntimeDeps): ExtensionRuntime => ({
  operations: deps.operations ? createProvisionOperations(deps.operations) : {},
  tools: {},
});
