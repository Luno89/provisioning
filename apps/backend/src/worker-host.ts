#!/usr/bin/env node
import dotenv from 'dotenv';
import { ignore } from '@koala/engine-core/failures';
import { Worker, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { RootRemovalInstanceActivity, RootRemovalMeshActivity, RootRemovalRecordsActivity } from './activities/RootRemovalActivities.js';
import { PoolMoveStartActivity, PoolMoveStopActivity, PoolMoveSwitchActivity } from './activities/PoolActivities.js';
import { PoolChartActivity, PoolFailedActivity, PoolHostActivity, PoolProxyActivity, PoolReadyActivity, PoolRemoveActivity, PoolSetupActivity, PoolTrialNextActivity, PoolTrialStepActivity, PoolVclusterActivity } from './activities/PoolActivities.js';
import { DependencyWatchActivity } from './activities/DependencyWatchActivity.js';
import { KoalaInstallAskActivity, KoalaInstallStageActivity, KoalaInstallStoppedActivity } from './activities/KoalaInstallActivities.js';
import { ServerOrderBootstrapActivity, ServerOrderDnsActivity, ServerOrderFailedActivity, ServerOrderFollowActivity, ServerOrderMailCheckActivity, ServerOrderRebuildActivity, ServerOrderReleaseActivity, ServerOrderReverseDnsActivity, ServerOrderSshActivity, ServerOrderStoppedActivity } from './activities/RootNodeActivities.js';
import { CrawlBatchActivity, NextBatchActivity, SeedFrontierActivity, DiscardFrontierActivity, PurgeCorpusActivity, NewIngestIdActivity } from './activities/CrawlActivity.js';
import { createWorkerLogger, buildDataConverter, connectTemporalWorker, connectTemporalAs, hostWorkerSettingsFrom, keepPayloadsIn, reopening, temporalTlsProblem, sharedPayloadBlobs, SettingsError, telemetrySettings } from './platform/index.js';
import { giveHostActivities, hostClusterAccess } from './activities/host-settings.js';
import { serveHealth, sharedClusterProxy } from './infrastructure/index.js';
import { collectorEndpoint, collectorSink } from './monitoring/index.js';
import { checkServices, collectorAnswers, reportCollectorTo, workerDependencies } from './platform/wiring/dependencies.js';
import { activityInterceptors, WORKER_DEFAULTS } from '@koala/engine-core';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { workflowInterceptorModules } from './worker-interceptors.js';
import { HOST_ACTIVITIES, QUEUES, type HostWorkerSettings } from './platform/index.js';
import { holdFencesIn, runThenLetGo } from './platform/wiring/fences.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const logger = createWorkerLogger('host-worker');

export const HOST_WORKER_ACTIVITIES = {
  PoolHostActivity, PoolVclusterActivity, PoolProxyActivity, PoolChartActivity, PoolReadyActivity, PoolSetupActivity, PoolFailedActivity,
  PoolTrialNextActivity, PoolTrialStepActivity, PoolRemoveActivity, PoolMoveStartActivity, PoolMoveSwitchActivity, PoolMoveStopActivity,
  DependencyWatchActivity,
  ServerOrderFollowActivity, ServerOrderRebuildActivity, ServerOrderSshActivity, ServerOrderDnsActivity, ServerOrderReleaseActivity,
  ServerOrderBootstrapActivity, ServerOrderReverseDnsActivity, ServerOrderMailCheckActivity, ServerOrderStoppedActivity, ServerOrderFailedActivity,
  RootRemovalInstanceActivity, RootRemovalMeshActivity, RootRemovalRecordsActivity,
  KoalaInstallAskActivity, KoalaInstallStageActivity, KoalaInstallStoppedActivity,
  CrawlBatchActivity, NextBatchActivity, SeedFrontierActivity, DiscardFrontierActivity, PurgeCorpusActivity, NewIngestIdActivity,
};

export function hostActivitiesFor(role: HostWorkerSettings['role']['role']): Partial<typeof HOST_WORKER_ACTIVITIES> {
  if (role === 'hub') throw new Error('the hub runs no host worker: no work of the hub\'s runs on the host queue');
  const names = HOST_ACTIVITIES[role];
  return Object.fromEntries(Object.entries(HOST_WORKER_ACTIVITIES).filter(([name]) => names.includes(name)));
}

export async function startHostWorker(settings: HostWorkerSettings) {
  logger.keepIn(settings.dataDir);
  const telemetry = startTelemetry(telemetrySettings(settings, 'koala-worker-host'));
  const access = hostClusterAccess(settings);
  const telemetryProxy = sharedClusterProxy(access);
  telemetry.exportTo(collectorSink({ otlpEndpoint: settings.telemetry.otlpEndpoint, proxy: telemetryProxy, koalasCluster: () => access.own().clusterId }));
  const dependencies = workerDependencies(settings, settings.mongo);
  reportCollectorTo(telemetry, dependencies);
  checkServices(dependencies, { webTools: settings.webTools });
  dependencies.checkWith('collector', collectorAnswers(settings.telemetry.otlpEndpoint ? () => settings.telemetry.otlpEndpoint : collectorEndpoint({ proxy: telemetryProxy, koalasCluster: () => access.own().clusterId })));
  const plaintext = temporalTlsProblem(settings.temporal);
  if (plaintext) throw new Error(plaintext);
  connectTemporalAs(settings);
  keepPayloadsIn(settings.mongo);
  const fences = await holdFencesIn('worker-host', settings.mongo);
  giveHostActivities(settings, access, dependencies);
  void dependencies.start();
  const queue = QUEUES.host;
  const { address } = settings.temporal;
  logger.info(`[HostWorker] Starting — taskQueue=${queue}, address=${address}`);

  let worker;
  const connecting = reopening();
  while (true) {
    try {
      const connection = await connectTemporalWorker('koala-worker-host', settings);
      const dataConverter = buildDataConverter(settings.keys.payload, sharedPayloadBlobs());
      worker = await Worker.create({
    ...WORKER_DEFAULTS,
        connection,
        namespace: settings.temporal.namespace,
        ...(dataConverter ? { dataConverter } : {}),
        taskQueue: queue,
        workflowsPath: resolve(__dirname, 'workflows'),
        interceptors: { activity: activityInterceptors(), workflowModules: workflowInterceptorModules(settings.role) },
        activities: hostActivitiesFor(settings.role.role),
      });
      break;
    } catch (err) {
      dependencies.failed('temporal', err);
      logger.warn(`[HostWorker] ⚠️ Connection to Temporal server failed: ${(err as Error).message}. Retrying in ${connecting.seconds} s`);
      await connecting.after();
    }
  }

  return { worker: worker!, telemetry, fences };
}

async function main() {
  dotenv.config({ quiet: true });
  const settings = hostWorkerSettingsFrom(process.env);
  Runtime.install({
    logger,
    telemetryOptions: {
      metrics: {
        prometheus: {
          bindAddress: `0.0.0.0:${settings.temporalMetricsPort}`,
        },
      },
    },
  });
  const { worker, telemetry, fences } = await startHostWorker(settings);
  logger.info(`[HostWorker] ✅ Listening for ${settings.role.role}'s work on the host queue`);
  if (settings.healthPort) serveHealth(settings.healthPort, () => worker.getState() === 'RUNNING');
  await runThenLetGo(worker, fences);
  await telemetry.shutdown().catch(ignore('the worker has stopped, and telemetry the collector did not take is dropped as it is whenever the collector is away'));
}

const startedAsProgram = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (startedAsProgram) main().then(() => {
  process.exit(0);
}, (err: Error) => {
  logger.error(err instanceof SettingsError ? `[HostWorker] ${err.message}` : `[HostWorker] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
