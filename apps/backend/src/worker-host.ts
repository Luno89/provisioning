#!/usr/bin/env node
/* eslint-disable no-console */
import dotenv from 'dotenv';
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { ProvisionClusterActivity } from './activities/ProvisionClusterActivity.js';
import { DestroyClusterActivity } from './activities/DestroyClusterActivity.js';
import { UpdateLeafActivity } from './activities/UpdateLeafActivity.js';
import { ExecuteLeafActivity } from './activities/ExecuteLeafActivity.js';
import { CheckLeafGateActivity, ReleaseDependentsActivity } from './activities/LeafGateActivity.js';
import { LandRequestActivity } from './activities/LandRequestActivity.js';
import { ResolveLandingActivity } from './activities/ResolveLandingActivity.js';
import { JudgeLeafActivity } from './activities/JudgeLeafActivity.js';
import { AcceptRequestActivity } from './activities/AcceptRequestActivity.js';
import { ReplanActivity } from './activities/ReplanActivity.js';
import { PlanProjectActivity } from './activities/PlanProjectActivity.js';
import { CrawlBatchActivity, NextBatchActivity, SeedFrontierActivity, DiscardFrontierActivity, PurgeCorpusActivity, SearchCorpusActivity, NewIngestIdActivity } from './activities/CrawlActivity.js';
import { createWorkerLogger } from './lib/worker-logger.js';
import { buildDataConverter } from './lib/temporal-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, '../.env') });

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
      const dataConverter = buildDataConverter(process.env.JWT_SECRET);
      worker = await Worker.create({
        connection,
        ...(dataConverter ? { dataConverter } : {}),
        taskQueue: queue,
        workflowsPath: resolve(__dirname, 'workflows'),
        activities: {
          ProvisionClusterActivity,
          DestroyClusterActivity,
          UpdateLeafActivity,
          ExecuteLeafActivity,
          CheckLeafGateActivity,
          ReleaseDependentsActivity,
          LandRequestActivity,
          ResolveLandingActivity,
          JudgeLeafActivity,
          AcceptRequestActivity,
          ReplanActivity,
          PlanProjectActivity,
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
  await worker.run();
}

main().catch((err) => {
  logger.error(`[HostWorker] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
