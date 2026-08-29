#!/usr/bin/env node
/* eslint-disable no-console */
import dotenv from 'dotenv';
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

import { DeployAppActivity } from './activities/DeployAppActivity.js';
import { CheckWorkloadActivity } from './activities/CheckWorkloadActivity.js';
import { DestroyAppActivity } from './activities/DestroyAppActivity.js';
import { ResizeDiskActivity } from './activities/ResizeDiskActivity.js';
import { SyncConfigActivity } from './activities/SyncConfigActivity.js';
import { DownloadModelActivity } from './activities/DownloadModelActivity.js';
import { RunPipelineActivity } from './activities/RunPipelineActivity.js';
import { createWorkerLogger } from './lib/worker-logger.js';
import { buildDataConverter } from './lib/temporal-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, '../.env') });
const SA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount';

const logger = createWorkerLogger('cluster-worker');

async function setupInClusterAuth() {
  if (process.env.IN_CLUSTER !== 'true') return;
  try {
    const [token, caCert] = await Promise.all([
      fs.readFile(`${SA_PATH}/token`, 'utf-8'),
      fs.readFile(`${SA_PATH}/ca.crt`, 'utf-8'),
    ]);
    process.env.K8S_HOST = process.env.K8S_HOST || 'https://kubernetes.default.svc';
    process.env.K8S_TOKEN = token;
    process.env.K8S_CA_CERT = caCert;
    logger.info('[ClusterWorker] In-cluster auth configured');
  } catch (err: any) {
    logger.warn(`[ClusterWorker] Failed to read service account: ${err.message}`);
  }
}

Runtime.install({
  logger,
  telemetryOptions: {
    metrics: {
      prometheus: {
        bindAddress: `0.0.0.0:${process.env.TEMPORAL_METRICS_PORT || '9464'}`,
      },
    },
  },
});

async function main() {
  await setupInClusterAuth();

  const queue = process.env.TEMPORAL_TASK_QUEUE || 'cluster-ops-queue';
  const address = process.env.TEMPORAL_CONNECTION_ADDRESS || 'localhost:7233';
  logger.info(`[ClusterWorker] Starting — taskQueue=${queue}, address=${address}`);

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
          DeployAppActivity,
          CheckWorkloadActivity,
          DestroyAppActivity,
          ResizeDiskActivity,
          SyncConfigActivity,
          DownloadModelActivity,
          RunPipelineActivity,
        },
      });
      break;
    } catch (err: any) {
      logger.warn(`[ClusterWorker] ⚠️ Connection to Temporal server failed: ${err.message}. Retrying in 10s...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }

  logger.info('[ClusterWorker] ✅ Listening for app deployment tasks');
  await worker.run();
}

main().catch((err) => {
  logger.error(`[ClusterWorker] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
