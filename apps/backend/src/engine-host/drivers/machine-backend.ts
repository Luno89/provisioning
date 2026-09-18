import {
  deleteFileOnDevice,
  execOnDevice,
  listDirOnDevice,
  readFileOnDevice,
  writeFileOnDevice,
} from '../../lib/local-agent-registry.js';
import type { MachineBackend } from './machine.js';
export type { MachineBackend };
import type { DirEntry, ExecResult } from '@koala/engine-core';

export interface LocalAgentCalls {
  exec: typeof execOnDevice;
  readFile: typeof readFileOnDevice;
  writeFile: typeof writeFileOnDevice;
  listDir: typeof listDirOnDevice;
  deleteFile: typeof deleteFileOnDevice;
}

const defaultCalls: LocalAgentCalls = {
  exec: execOnDevice,
  readFile: readFileOnDevice,
  writeFile: writeFileOnDevice,
  listDir: listDirOnDevice,
  deleteFile: deleteFileOnDevice,
};

export function createMachineBackend(calls: LocalAgentCalls = defaultCalls): MachineBackend {
  return {
    async exec(input): Promise<ExecResult> {
      const result = await calls.exec(
        input.deviceId,
        input.ownerId,
        input.sessionId,
        input.command,
        input.timeoutMs,
        input.cwd,
      );

      return {
        stdout: result.stdout,
        stderr: result.timedOut ? `${result.stderr}\n[the machine stopped responding]`.trim() : result.stderr,
        exitCode: result.exitCode,
      };
    },

    async readFile(input): Promise<string> {
      return calls.readFile(input.deviceId, input.ownerId, input.sessionId, input.path);
    },

    async writeFile(input): Promise<void> {
      await calls.writeFile(input.deviceId, input.ownerId, input.sessionId, input.path, input.content);
    },

    async listDir(input): Promise<DirEntry[]> {
      const entries = await calls.listDir(input.deviceId, input.ownerId, input.path);
      return entries.map((entry) => ({ name: entry.name, type: entry.type }));
    },

    async deleteFile(input): Promise<void> {
      await calls.deleteFile(input.deviceId, input.ownerId, input.path);
    },
  };
}
