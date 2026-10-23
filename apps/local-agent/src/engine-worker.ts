import { Context } from '@temporalio/activity';
import { Worker, NativeConnection } from '@temporalio/worker';
import { buildDataConverter, type BlobReach, type Keyring } from '@koala/engine-core/payloads';
import { executeTool, heartbeatWhileRunning, type ExternalAgentStepArgs, type ExternalAgentStepResult, type MachineGitOp, type MachineGitResult, type ToolContract } from '@koala/engine-core';
import { traceActivities } from '@koala/engine-core/telemetry';
import { createLocalFsDriver } from './local-fs-driver.js';
import type { ExternalAgentSessions } from './external-agents.js';

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
  { name: 'run_command', description: 'Run a shell command; it runs until it ends unless timeoutSeconds is given', binding: 'environment', requires: { terminal: true } },
  { name: 'read_file', description: 'Read a file', binding: 'environment', requires: { filesystem: true } },
  { name: 'write_file', description: 'Write a file', binding: 'environment', requires: { filesystem: true } },
  { name: 'list_dir', description: 'List a directory', binding: 'environment', requires: { filesystem: true } },
  { name: 'delete_file', description: 'Delete a file', binding: 'environment', requires: { filesystem: true } },
];

export interface DeviceActivitiesOptions {
  rootDir: string;
  deviceId: string;
  languages?: string[];
  externalAgents?: ExternalAgentSessions | undefined;
  git?: ((op: MachineGitOp) => Promise<MachineGitResult>) | undefined;
}

export const HEARTBEAT_MS = 10_000;

const activityContext = (): Context | undefined => {
  try {
    return Context.current();
  } catch {
    return undefined;
  }
};

export function createDeviceActivities(options: DeviceActivitiesOptions) {
  return {
    async ExternalAgentActivity(args: ExternalAgentStepArgs): Promise<ExternalAgentStepResult> {
      if (!options.externalAgents) return { state: 'failed', error: 'this machine runs no external agents', events: [] };
      const context = activityContext();
      return options.externalAgents.step(args, () => context?.heartbeat());
    },

    async MachineGitActivity(op: MachineGitOp): Promise<MachineGitResult> {
      if (!options.git) return { ok: false, error: 'this machine cannot fetch or push a project\'s work' };
      return options.git(op);
    },

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

      const context = activityContext();
      const beating = context ? setInterval(() => context.heartbeat(), HEARTBEAT_MS) : undefined;
      const outcome = await executeTool({
        name: args.name,
        arguments: args.arguments,
        granted: args.granted ?? [],
        catalogue: DEVICE_TOOLS,
        driver,
        ...(context ? { signal: context.cancellationSignal } : {}),
      }).finally(() => { if (beating) clearInterval(beating); });

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
  payloads: { ring: Keyring; blobs: BlobReach };
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
    dataConverter: buildDataConverter(options.payloads.ring, options.payloads.blobs),
    interceptors: { activity: [heartbeatWhileRunning(), traceActivities()] },
    ...(options.namespace ? { namespace: options.namespace } : {}),
    activities: createDeviceActivities(options),
  });

  options.onReady?.(taskQueue);
  return worker;
}
