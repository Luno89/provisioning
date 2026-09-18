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
import type { ApprovalGate } from '@koala/agent-engine';
import { scopedPath, scopeRoot } from '@koala/engine-core';

export interface MachineCall {
  deviceId: string;
  ownerId: string;
  sessionId: string;
}

export interface MachineBackend {
  exec(input: MachineCall & { command: string; cwd?: string | undefined; timeoutMs?: number | undefined }): Promise<ExecResult>;
  readFile(input: MachineCall & { path: string }): Promise<string>;
  writeFile(input: MachineCall & { path: string; content: string }): Promise<void>;
  listDir(input: MachineCall & { path: string }): Promise<DirEntry[]>;
  deleteFile(input: MachineCall & { path: string }): Promise<void>;
}

export interface MachineDriverOptions {
  deviceId: string;
  deviceName?: string | undefined;
  ownerId: string;
  runId: string;
  agentSlug: string;
  scope?: EnvironmentScope | undefined;
  languages?: string[] | undefined;
  backend: MachineBackend;
  approval: ApprovalGate;
}

export function createMachineDriver(options: MachineDriverOptions): EnvironmentDriver {
  const spec: EnvironmentSpec = {
    kind: 'machine',
    lifecycle: 'persistent',
    ...(options.languages ? { languages: [...options.languages] } : {}),
    egress: true,
  };

  const scope: EnvironmentScope = {
    deviceId: options.deviceId,
    ...(options.scope?.path ? { path: options.scope.path } : {}),
    ...(options.scope?.worktree ? { worktree: options.scope.worktree } : {}),
  };

  const handle: EnvironmentHandle = {
    id: `machine:${options.deviceId}:${scopeRoot(scope) || '.'}`,
    spec,
    capabilities: capabilitiesOf(spec),
    scope,
    approval: 'per-command',
  };

  const at = (requested: string): string => scopedPath(scope, requested);

  const call = {
    deviceId: options.deviceId,
    ownerId: options.ownerId,
    sessionId: options.runId,
  };

  return {
    handle: () => handle,

    async exec(request: ExecRequest): Promise<ExecResult> {
      const verdict = await options.approval.guard({
        handle,
        request,
        runId: options.runId,
        agentSlug: options.agentSlug,
      });

      if (!verdict.allowed) {
        return { stdout: '', stderr: verdict.reason ?? 'That command was not approved.', exitCode: 126 };
      }

      const cwd = request.cwd ? at(request.cwd) : scopeRoot(scope) || undefined;

      return options.backend.exec({
        deviceId: options.deviceId,
        ownerId: options.ownerId,
        sessionId: options.runId,
        command: request.command,
        ...(cwd ? { cwd } : {}),
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      });
    },

    async readFile(path: string): Promise<string> {
      return options.backend.readFile({ ...call, path: at(path) });
    },

    async writeFile(path: string, content: string): Promise<void> {
      return options.backend.writeFile({ ...call, path: at(path), content });
    },

    async listDir(path: string): Promise<DirEntry[]> {
      return options.backend.listDir({ ...call, path: at(path) });
    },

    async deleteFile(path: string): Promise<void> {
      return options.backend.deleteFile({ ...call, path: at(path) });
    },
  };
}
