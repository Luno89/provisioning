import { WORK_DIR } from '../sandboxes/workspace.js';
import {
  capabilitiesOf,
  type DirEntry,
  type EnvironmentDriver,
  type EnvironmentHandle,
  type EnvironmentScope,
  type EnvironmentSpec,
  type ExecRequest,
  type ExecResult,
} from '@koala/engine-core';
import { scopedPath, scopeRoot } from '@koala/engine-core';

export interface SandboxBackend {
  exec(input: { sandboxId: string; command: string; cwd?: string | undefined; timeoutMs?: number | undefined }): Promise<ExecResult>;
  readFile(input: { sandboxId: string; path: string }): Promise<string>;
  writeFile(input: { sandboxId: string; path: string; content: string }): Promise<void>;
  listDir(input: { sandboxId: string; path: string }): Promise<DirEntry[]>;
  deleteFile(input: { sandboxId: string; path: string }): Promise<void>;
  snapshot?(input: { sandboxId: string }): Promise<string>;
  restore?(input: { sandboxId: string; reference: string }): Promise<void>;
  destroy?(input: { sandboxId: string }): Promise<void>;
}

export interface SandboxDriverOptions {
  sandboxId: string;
  spec: EnvironmentSpec;
  scope?: EnvironmentScope | undefined;
  root?: string | undefined;
  backend: SandboxBackend;
}

export function createSandboxDriver(options: SandboxDriverOptions): EnvironmentDriver {
  const { sandboxId, backend } = options;

  const handle: EnvironmentHandle = {
    id: `sandbox:${sandboxId}`,
    spec: options.spec,
    capabilities: capabilitiesOf(options.spec),
    ...(options.scope ? { scope: options.scope } : {}),
    approval: 'none',
  };

  const root = options.root ?? WORK_DIR;

  const at = (requested: string): string => {
    if (options.scope) return scopedPath(options.scope, requested);
    if (requested === root) return '.';
    const inside = requested.startsWith(`${root}/`) ? requested.slice(root.length + 1) : requested;
    return scopedPath(undefined, inside);
  };

  const driver: EnvironmentDriver = {
    handle: () => handle,

    async exec(request: ExecRequest): Promise<ExecResult> {
      const cwd = request.cwd ? at(request.cwd) : scopeRoot(options.scope) || undefined;
      return backend.exec({
        sandboxId,
        command: request.command,
        ...(cwd ? { cwd } : {}),
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      });
    },

    async readFile(path: string): Promise<string> {
      return backend.readFile({ sandboxId, path: at(path) });
    },

    async writeFile(path: string, content: string): Promise<void> {
      return backend.writeFile({ sandboxId, path: at(path), content });
    },

    async listDir(path: string): Promise<DirEntry[]> {
      return backend.listDir({ sandboxId, path: at(path) });
    },

    async deleteFile(path: string): Promise<void> {
      return backend.deleteFile({ sandboxId, path: at(path) });
    },
  };

  if (backend.snapshot) {
    driver.checkpoint = async (): Promise<string> => backend.snapshot!({ sandboxId });
  }

  if (backend.restore) {
    driver.restore = async (reference: string): Promise<void> => backend.restore!({ sandboxId, reference });
  }

  if (backend.destroy) {
    driver.dispose = async (): Promise<void> => backend.destroy!({ sandboxId });
  }

  return driver;
}
