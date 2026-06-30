#!/usr/bin/env node
/* eslint-disable no-console */
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { ProvisionClusterActivity } from './activities/ProvisionClusterActivity.js';
import { DestroyClusterActivity } from './activities/DestroyClusterActivity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const queue = process.env.TEMPORAL_TASK_QUEUE || 'provisioning-ops-queue';
  console.log(`[HostWorker] Starting — taskQueue=${queue}`);

  const worker = await Worker.create({
    taskQueue: queue,
    workflowsPath: resolve(__dirname, 'workflows'),
    activities: {
      ProvisionClusterActivity,
      DestroyClusterActivity,
    },
    failFast: true,
  });

  console.log('[HostWorker] ✅ Listening for cluster provisioning tasks');
  await worker.run();
}

main().catch((err) => {
  console.error('[HostWorker] FATAL:', err);
  process.exit(1);
});
