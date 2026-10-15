import type { ExtensionRuntime } from '../types.js';
import { createReleaseOperations, type ReleaseOperationDeps } from './operations/handlers.js';

export interface ReleasesRuntimeDeps {
  operations?: ReleaseOperationDeps | undefined;
}

export const releasesRuntime = (deps: ReleasesRuntimeDeps): ExtensionRuntime => ({
  operations: deps.operations ? createReleaseOperations(deps.operations) : {},
  tools: {},
});
