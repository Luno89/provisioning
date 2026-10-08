import type { ExtensionRuntime } from '../types.js';
import { createPlatformOperations, type PlatformOperationDeps } from './operations/handlers.js';

export interface PlatformRuntimeDeps {
  operations?: PlatformOperationDeps | undefined;
}

export const platformRuntime = (deps: PlatformRuntimeDeps): ExtensionRuntime => ({
  operations: deps.operations ? createPlatformOperations(deps.operations) : {},
  tools: {},
});
