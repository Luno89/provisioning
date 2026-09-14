import { Worker, NativeConnection } from '@temporalio/worker';
import { executeTool, type ToolContract } from '@koala/engine-core';
import { createLocalFsDriver } from './local-fs-driver.js';

export interface DeviceToolCall {
  ticket: { runId: string; ownerId: string; agentSlug: string };
  nodeId: string;
  name: string;
  arguments: string;
  callId?: string;
  granted?: string[];
  environment?: {
    scope?: { deviceId?: string; path?: string; worktree?: string };
  };
}

export interface DeviceToolOutcome {
  ok: boolean;
  digest: string;
  content?: string;
}

export const DEVICE_TOOLS: ToolContract[] = [
  { name: 'run_command', description: 'Run a shell command', binding: 'environment', requires: { terminal: true } },
  { name: 'read_file', description: 'Read a file', binding: 'environment', requires: { filesystem: true } },
  { name: 'write_file', description: 'Write a file', binding: 'environment', requires: { filesystem: true } },
  { name: 'list_dir', description: 'List a directory', binding: 'environment', requires: { filesystem: true } },
  { name: 'delete_file', description: 'Delete a file', binding: 'environment', requires: { filesystem: true } },
];

export interface DeviceActivitiesOptions {
  rootDir: string;
  deviceId: string;
  languages?: string[];
}

export function createDeviceActivities(options: DeviceActivitiesOptions) {
  return {
    async EngineToolActivity(args: DeviceToolCall): Promise<DeviceToolOutcome> {
      const scope = args.environment?.scope;

      const driver = createLocalFsDriver({
        rootDir: options.rootDir,
        deviceId: options.deviceId,
        ...(options.languages ? { languages: options.languages } : {}),
        ...(scope?.path || scope?.worktree
          ? {
            scope: {
              ...(scope.path ? { path: scope.path } : {}),
              ...(scope.worktree ? { worktree: scope.worktree } : {}),
            },
          }
          : {}),
      });

      const outcome = await executeTool({
        name: args.name,
        arguments: args.arguments,
        granted: args.granted ?? [],
        catalogue: DEVICE_TOOLS,
        driver,
      });

      return {
        ok: outcome.ok,
        digest: outcome.digest,
        ...(outcome.content === undefined ? {} : { content: outcome.content }),
      };
    },
  };
}

export interface DeviceWorkerOptions extends DeviceActivitiesOptions {
  address: string;
  namespace?: string | undefined;
  onReady?: ((queue: string) => void) | undefined;
}

export const deviceQueue = (deviceId: string): string => `device-${deviceId}`;

export async function startDeviceWorker(options: DeviceWorkerOptions): Promise<Worker> {
  const connection = await NativeConnection.connect({ address: options.address });
  const taskQueue = deviceQueue(options.deviceId);

  const worker = await Worker.create({
    connection,
    taskQueue,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    activities: createDeviceActivities(options),
  });

  options.onReady?.(taskQueue);
  return worker;
}
