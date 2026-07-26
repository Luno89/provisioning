#!/usr/bin/env node
/* eslint-disable no-console */
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

import { DeployAppActivity } from './activities/DeployAppActivity.js';
import { DestroyAppActivity } from './activities/DestroyAppActivity.js';
import { ResizeDiskActivity } from './activities/ResizeDiskActivity.js';
import { SyncConfigActivity } from './activities/SyncConfigActivity.js';
import { DownloadModelActivity } from './activities/DownloadModelActivity.js';
import { RunPipelineActivity } from './activities/RunPipelineActivity.js';
import { createWorkerLogger } from './lib/worker-logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

// Must run once, before the first NativeConnection/Worker is created — the SDK's metrics
// registry is wired up at Runtime construction time. Exposes workflow/activity success, failure,
// and latency counters on :9464/metrics — scraped by k8s/worker-podmonitor.yaml when running as
// the in-cluster pod (IN_CLUSTER=true), or by kube-prometheus-stack's additionalScrapeConfigs
// (see monitoring.ts) when running as a bare host process on local dev — this exact bind
// port/path is baked into both, so keep them in sync if this ever changes.
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
      worker = await Worker.create({
        connection,
        taskQueue: queue,
        workflowsPath: resolve(__dirname, 'workflows'),
        activities: {
          DeployAppActivity,
          DestroyAppActivity,
          ResizeDiskActivity,
          SyncConfigActivity,
          DownloadModelActivity,
          RunPipelineActivity,
        },
        failFast: true,
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
