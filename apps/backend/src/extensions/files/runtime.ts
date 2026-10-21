import type { ExtensionRuntime } from '../types.js';
import { createFilesTools, type FilesToolDeps } from './handlers.js';

export interface FilesRuntimeDeps {
  tools?: FilesToolDeps | undefined;
}

export const filesRuntime = (deps: FilesRuntimeDeps): ExtensionRuntime => ({
  operations: {},
  tools: createFilesTools(deps.tools),
});
