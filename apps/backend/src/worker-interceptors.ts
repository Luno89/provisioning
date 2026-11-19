import { resolve } from 'node:path';
import type { Logger, Worker } from '@temporalio/worker';
import { createWorker } from '@koala/engine-core/temporal';
import { connectTemporalWorker, reopening, servesTenants, sharedPayloadBlobs, type DependencyStates, type PlatformKeys, type RoleConfig, type TemporalSettings } from './platform/index.js';

export function workflowInterceptorModules(role: RoleConfig): string[] {
  const modules = [resolve(import.meta.dirname, 'workflows/telemetry-interceptors.ts')];
  if (servesTenants(role)) modules.push(resolve(import.meta.dirname, 'workflows/failure-reports.ts'));
  return modules;
}

export interface BackendWorkerSettings {
  temporal: TemporalSettings;
  keys: Pick<PlatformKeys, 'temporal' | 'payload'>;
  role: RoleConfig;
}

export async function backendWorker(subject: string, settings: BackendWorkerSettings, taskQueue: string, activities: object): Promise<Worker> {
  const connection = await connectTemporalWorker(subject, settings);
  return createWorker({
    connection,
    namespace: settings.temporal.namespace,
    payloads: { ring: settings.keys.payload, blobs: sharedPayloadBlobs() },
    taskQueue,
    workflowsPath: resolve(import.meta.dirname, 'workflows'),
    workflowModules: workflowInterceptorModules(settings.role),
    activities,
  });
}

export async function backendWorkerOnceTemporalAnswers(subject: string, settings: BackendWorkerSettings, taskQueue: string, activities: () => object, said: { tag: string; logger: Logger; dependencies: DependencyStates }): Promise<Worker> {
  const connecting = reopening();
  for (;;) {
    try {
      return await backendWorker(subject, settings, taskQueue, activities());
    } catch (err) {
      said.dependencies.failed('temporal', err);
      said.logger.warn(`${said.tag} ⚠️ Connection to Temporal server failed: ${(err as Error).message}. Retrying in ${connecting.seconds} s`);
      await connecting.after();
    }
  }
}
