#!/usr/bin/env node
import dotenv from 'dotenv';
import { ignore } from '@koala/engine-core/failures';
import { Worker, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { RootRemovalInstanceActivity, RootRemovalMeshActivity, RootRemovalRecordsActivity } from './activities/RootRemovalActivities.js';
import { PoolMoveStartActivity, PoolMoveStopActivity, PoolMoveSwitchActivity } from './activities/PoolActivities.js';
import { PoolChartActivity, PoolFailedActivity, PoolHostActivity, PoolProxyActivity, PoolReadyActivity, PoolRemoveActivity, PoolTrialNextActivity, PoolTrialStepActivity, PoolVclusterActivity } from './activities/PoolActivities.js';
import { DependencyWatchActivity } from './activities/DependencyWatchActivity.js';
import { ServerOrderBootstrapActivity, ServerOrderDnsActivity, ServerOrderFailedActivity, ServerOrderFollowActivity, ServerOrderMailCheckActivity, ServerOrderRebuildActivity, ServerOrderReleaseActivity, ServerOrderReverseDnsActivity, ServerOrderSshActivity, ServerOrderStoppedActivity } from './activities/RootNodeActivities.js';
import { CrawlBatchActivity, NextBatchActivity, SeedFrontierActivity, DiscardFrontierActivity, PurgeCorpusActivity, SearchCorpusActivity, NewIngestIdActivity } from './activities/CrawlActivity.js';
import { createWorkerLogger, buildDataConverter, connectTemporalWorker, connectTemporalAs, hostWorkerSettingsFrom, keepPayloadsIn, reopening, temporalTlsProblem, sharedPayloadBlobs, SettingsError, telemetrySettings } from './platform/index.js';
import { giveHostActivities, hostClusterAccess } from './activities/host-settings.js';
import { serveHealth, sharedClusterProxy } from './infrastructure/index.js';
import { collectorEndpoint, collectorSink } from './monitoring/index.js';
import { collectorAnswers, reportCollectorTo, workerDependencies } from './platform/wiring/dependencies.js';
import { heartbeatWhileRunning, WORKER_DEFAULTS } from '@koala/engine-core';
import { traceActivities } from '@koala/engine-core/telemetry';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { workflowInterceptorModules } from './worker-interceptors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ quiet: true });

const logger = createWorkerLogger('host-worker');

async function main() {
  const settings = hostWorkerSettingsFrom(process.env);
  const telemetry = startTelemetry(telemetrySettings(settings, 'koala-worker-host'));
  const access = hostClusterAccess(settings);
  const telemetryProxy = sharedClusterProxy(access);
  telemetry.exportTo(collectorSink({ otlpEndpoint: settings.telemetry.otlpEndpoint, proxy: telemetryProxy, koalasCluster: () => access.own().clusterId }));
  const dependencies = workerDependencies(settings, settings.mongo);
  reportCollectorTo(telemetry, dependencies);
  dependencies.checkWith('collector', collectorAnswers(settings.telemetry.otlpEndpoint ? () => settings.telemetry.otlpEndpoint : collectorEndpoint({ proxy: telemetryProxy, koalasCluster: () => access.own().clusterId })));
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
  const plaintext = temporalTlsProblem(settings.temporal);
  if (plaintext) throw new Error(plaintext);
  connectTemporalAs(settings);
  keepPayloadsIn(settings.mongo);
  giveHostActivities(settings, access);
  void dependencies.start();
  const queue = settings.queues.own || 'host-ops-queue';
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
        interceptors: { activity: [heartbeatWhileRunning(), traceActivities()], workflowModules: workflowInterceptorModules(settings.role) },
        activities: {
          PoolHostActivity,
          PoolVclusterActivity,
          PoolProxyActivity,
          PoolChartActivity,
          PoolReadyActivity,
          PoolFailedActivity,
          PoolTrialNextActivity,
          PoolTrialStepActivity,
          PoolRemoveActivity,
          PoolMoveStartActivity,
          PoolMoveSwitchActivity,
          PoolMoveStopActivity,
          DependencyWatchActivity,
          ServerOrderFollowActivity,
          ServerOrderRebuildActivity,
          ServerOrderSshActivity,
          ServerOrderDnsActivity,
          ServerOrderReleaseActivity,
          ServerOrderBootstrapActivity,
          ServerOrderReverseDnsActivity,
          ServerOrderMailCheckActivity,
          ServerOrderStoppedActivity,
          ServerOrderFailedActivity,
          RootRemovalInstanceActivity,
          RootRemovalMeshActivity,
          RootRemovalRecordsActivity,
          CrawlBatchActivity,
          NextBatchActivity,
          SeedFrontierActivity,
          DiscardFrontierActivity,
          PurgeCorpusActivity,
          SearchCorpusActivity,
          NewIngestIdActivity,
        },
      });
      break;
    } catch (err) {
      dependencies.failed('temporal', err);
      logger.warn(`[HostWorker] ⚠️ Connection to Temporal server failed: ${(err as Error).message}. Retrying in ${connecting.seconds} s`);
      await connecting.after();
    }
  }

  logger.info('[HostWorker] ✅ Listening for the work of root, the pool and server orders');
  if (settings.healthPort) serveHealth(settings.healthPort, () => worker.getState() === 'RUNNING');
  await worker.run();
  await telemetry.shutdown().catch(ignore('the worker has stopped, and telemetry the collector did not take is dropped as it is whenever the collector is away'));
}

main().then(() => {
  process.exit(0);
}, (err: Error) => {
  logger.error(err instanceof SettingsError ? `[HostWorker] ${err.message}` : `[HostWorker] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
