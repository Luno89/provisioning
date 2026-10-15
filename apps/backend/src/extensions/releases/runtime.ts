import type { ExtensionRuntime } from '../types.js';
import { createReleaseOperations, type ReleaseOperationDeps } from './operations/handlers.js';
import { createReleaseTools, type ReleaseToolDeps } from './tools/handlers.js';

export interface ReleasesRuntimeDeps {
  operations?: ReleaseOperationDeps | undefined;
  tools?: ReleaseToolDeps | undefined;
}

export const releasesRuntime = (deps: ReleasesRuntimeDeps): ExtensionRuntime => ({
  operations: deps.operations ? createReleaseOperations(deps.operations) : {},
  tools: deps.tools ? createReleaseTools(deps.tools) : {},
});
