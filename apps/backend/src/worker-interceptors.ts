import { resolve } from 'node:path';
import type { Logger, Worker } from '@temporalio/worker';
import { createWorker } from '@koala/engine-core/temporal';
import { connectTemporalWorker, givenDeletingMarks, isOff, reopening, servesTenants, sharedPayloadBlobs, type Off, type DependencyStates, type PlatformKeys, type RoleConfig, type TemporalSettings } from './platform/index.js';

export function workflowInterceptorModules(role: RoleConfig): string[] {
  const modules = [resolve(import.meta.dirname, 'workflows/telemetry-interceptors.ts')];
  if (servesTenants(role)) modules.push(resolve(import.meta.dirname, 'workflows/failure-reports.ts'));
  return modules;
}

export interface BackendWorkerSettings {
  temporal: TemporalSettings;
  keys: Pick<PlatformKeys, 'temporal' | 'payload'>;
  role: RoleConfig;
  pod: string | Off;
}

export interface BackendWorker {
  subject: string;
  taskQueue: string;
  activities: object;
}

export async function backendWorker(settings: BackendWorkerSettings, { subject, taskQueue, activities }: BackendWorker): Promise<Worker> {
  const connection = await connectTemporalWorker(subject, settings);
  return createWorker({
    connection,
    namespace: settings.temporal.namespace,
    payloads: { ring: settings.keys.payload, blobs: sharedPayloadBlobs() },
    taskQueue,
    workflowsPath: resolve(import.meta.dirname, 'workflows'),
    workflowModules: workflowInterceptorModules(settings.role),
    activities,
    deletingMarks: givenDeletingMarks(),
    ...(isOff(settings.pod) ? {} : { identity: settings.pod }),
  });
}

export async function backendWorkerOnceTemporalAnswers(settings: BackendWorkerSettings, said: { tag: string; logger: Logger; dependencies: DependencyStates }, worker: BackendWorker): Promise<Worker> {
  const connecting = reopening();
  for (;;) {
    try {
      return await backendWorker(settings, worker);
    } catch (err) {
      said.dependencies.failed('temporal', err);
      said.logger.warn(`${said.tag} ⚠️ Connection to Temporal server failed: ${(err as Error).message}. Retrying in ${connecting.seconds} s`);
      await connecting.after();
    }
  }
}
