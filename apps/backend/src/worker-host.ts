#!/usr/bin/env node
/* eslint-disable no-console */
import { Worker, NativeConnection } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { ProvisionClusterActivity } from './activities/ProvisionClusterActivity.js';
import { DestroyClusterActivity } from './activities/DestroyClusterActivity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const queue = process.env.TEMPORAL_TASK_QUEUE || 'host-ops-queue';
  const address = process.env.TEMPORAL_CONNECTION_ADDRESS || 'localhost:7233';
  console.log(`[HostWorker] Starting — taskQueue=${queue}, address=${address}`);

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
        failFast: true,
      });
      break;
    } catch (err: any) {
      console.warn(`[HostWorker] ⚠️ Connection to Temporal server failed: ${err.message}. Retrying in 10s...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }

  console.log('[HostWorker] ✅ Listening for cluster provisioning tasks');
  await worker.run();
}

main().catch((err) => {
  console.error('[HostWorker] FATAL:', err);
  process.exit(1);
});
