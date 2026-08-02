#!/usr/bin/env node
/* eslint-disable no-console */
import dotenv from 'dotenv';
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { ProvisionClusterActivity } from './activities/ProvisionClusterActivity.js';
import { DestroyClusterActivity } from './activities/DestroyClusterActivity.js';
import { UpdateCardActivity } from './activities/UpdateCardActivity.js';
import { ExecuteCardActivity } from './activities/ExecuteCardActivity.js';
import { createWorkerLogger } from './lib/worker-logger.js';
import { buildDataConverter } from './lib/temporal-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// index.ts loads this for the backend, but the workers are separate processes that never did —
// so every process.env lookup here silently saw undefined. That went unnoticed until the Temporal
// PayloadCodec needed JWT_SECRET: the backend's client encrypted payloads while the workers, with
// no key, built no codec and could not decode them.
//
// Resolved from this file rather than process.cwd() so it works regardless of where the worker is
// launched from. A missing file is fine — in-cluster the values come from the pod's env, and
// dotenv never overwrites an already-set variable.
dotenv.config({ path: resolve(__dirname, '../.env') });

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
      const dataConverter = buildDataConverter(process.env.JWT_SECRET);
      worker = await Worker.create({
        connection,
        // Must match the client's converter (lib/temporal-client.ts) or this worker cannot decode
        // the arguments it is handed.
        ...(dataConverter ? { dataConverter } : {}),
        taskQueue: queue,
        workflowsPath: resolve(__dirname, 'workflows'),
        activities: {
          ProvisionClusterActivity,
          DestroyClusterActivity,
          // Board cards run on the host queue: they orchestrate and write to the database, and
          // need none of the in-cluster worker's Docker or kubeconfig access.
          UpdateCardActivity,
          ExecuteCardActivity,
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
