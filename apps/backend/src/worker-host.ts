#!/usr/bin/env node
/* eslint-disable no-console */
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { ProvisionClusterActivity } from './activities/ProvisionClusterActivity.js';
import { DestroyClusterActivity } from './activities/DestroyClusterActivity.js';
import { createWorkerLogger } from './lib/worker-logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const logger = createWorkerLogger('host-worker');

// Same metrics wiring as worker-cluster.ts. This worker is a plain host process (not a k8s pod)
// on local dev, so it's scraped via kube-prometheus-stack's additionalScrapeConfigs (see
// packages/cdktf-infra/constructs/monitoring.ts) rather than a PodMonitor — that only targets
// worker-cluster.ts's in-cluster pod form (k8s/worker-podmonitor.yaml). Different default port
// (9465, not 9464) since `npm run dev` runs this alongside worker-cluster.ts on the same host —
// same port would collide.
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
      worker = await Worker.create({
        connection,
        taskQueue: queue,
        workflowsPath: resolve(__dirname, 'workflows'),
        activities: {
          ProvisionClusterActivity,
          DestroyClusterActivity,
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
