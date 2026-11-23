import { resolve } from 'node:path';
import type { Logger, Worker } from '@temporalio/worker';
import { createWorker } from '@koala/engine-core/temporal';
import { connectTemporalWorker, failureOf, givenDeletingMarks, isOff, reopening, servesTenants, sharedPayloadBlobs, untilTemporalSetUp, type Off, type DependencyStates, type PlatformKeys, type RoleConfig, type TemporalSettings } from './platform/index.js';

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
  await untilTemporalSetUp(connection, settings.temporal.namespace, (line) => console.warn(`[${subject}] ${line}`));
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

export interface StartSaid {
  tag: string;
  logger: Pick<Logger, 'warn'>;
  dependencies: Pick<DependencyStates, 'failed'>;
}

export function backendWorkerOnceTemporalAnswers(settings: BackendWorkerSettings, said: StartSaid, worker: BackendWorker): Promise<Worker> {
  return onceTemporalAnswers(() => backendWorker(settings, worker), said);
}

export async function onceTemporalAnswers<T>(start: () => Promise<T>, said: StartSaid): Promise<T> {
  const connecting = reopening();
  for (;;) {
    try {
      return await start();
    } catch (err) {
      const failure = failureOf(err);
      if (failure.kind === 'final') throw new Error(`${said.tag} cannot start: ${failure.reason}`, { cause: err });
      said.dependencies.failed('temporal', err);
      said.logger.warn(`${said.tag} ⚠️ Connection to Temporal server failed: ${(err as Error).message}. Retrying in ${connecting.seconds} s`);
      await connecting.after();
    }
  }
}
