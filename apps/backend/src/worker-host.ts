#!/usr/bin/env node
import dotenv from 'dotenv';
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { ProvisionClusterActivity } from './activities/ProvisionClusterActivity.js';
import { DestroyClusterActivity } from './activities/DestroyClusterActivity.js';
import { RootRemovalInstanceActivity, RootRemovalMeshActivity, RootRemovalRecordsActivity } from './activities/RootRemovalActivities.js';
import { PoolMoveStartActivity, PoolMoveStopActivity, PoolMoveSwitchActivity } from './activities/PoolActivities.js';
import { PoolChartActivity, PoolFailedActivity, PoolHostActivity, PoolProxyActivity, PoolReadyActivity, PoolRemoveActivity, PoolTrialNextActivity, PoolTrialStepActivity, PoolVclusterActivity } from './activities/PoolActivities.js';
import { CrawlBatchActivity, NextBatchActivity, SeedFrontierActivity, DiscardFrontierActivity, PurgeCorpusActivity, SearchCorpusActivity, NewIngestIdActivity } from './activities/CrawlActivity.js';
import { createWorkerLogger, buildDataConverter, sharedPayloadBlobs, loadKeys, SYSTEM_KUBECONFIG, telemetrySettings } from './platform/index.js';
import { healthPort, serveHealth, sharedClusterProxy } from './infrastructure/index.js';
import { collectorSink } from './monitoring/index.js';
import { heartbeatWhileRunning } from '@koala/engine-core';
import { traceActivities } from '@koala/engine-core/telemetry';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, '../.env') });

const telemetry = startTelemetry(telemetrySettings(process.env, 'koala-worker-host'));
telemetry.exportTo(collectorSink({ env: process.env, proxy: sharedClusterProxy(), kubeconfigPath: () => process.env.KUBECONFIG_PATH || SYSTEM_KUBECONFIG }));

const logger = createWorkerLogger('host-worker');

Runtime.install({
  logger,
  telemetryOptions: {
    metrics: {
      prometheus: {
        bindAddress: `0.0.0.0:${process.env.TEMPORAL_METRICS_PORT || '9465'}`,
      },
    },
  },
});

async function main() {
  const queue = process.env.TEMPORAL_TASK_QUEUE || 'host-ops-queue';
  const address = process.env.TEMPORAL_CONNECTION_ADDRESS || 'localhost:7233';
  logger.info(`[HostWorker] Starting — taskQueue=${queue}, address=${address}`);

  let worker;
  while (true) {
    try {
      const connection = await NativeConnection.connect({ address });
      const dataConverter = buildDataConverter(loadKeys(process.env).payload, sharedPayloadBlobs());
      worker = await Worker.create({
        connection,
        ...(dataConverter ? { dataConverter } : {}),
        taskQueue: queue,
        workflowsPath: resolve(__dirname, 'workflows'),
        interceptors: { activity: [heartbeatWhileRunning(), traceActivities()], workflowModules: [resolve(__dirname, 'workflows/telemetry-interceptors.ts')] },
        activities: {
          ProvisionClusterActivity,
          DestroyClusterActivity,
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
    } catch (err: any) {
      logger.warn(`[HostWorker] ⚠️ Connection to Temporal server failed: ${err.message}. Retrying in 10s...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }

  logger.info('[HostWorker] ✅ Listening for cluster provisioning tasks');
  const port = healthPort(process.env);
  if (port) serveHealth(port, () => worker.getState() === 'RUNNING');
  await worker.run();
}

main().catch((err) => {
  logger.error(`[HostWorker] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
