#!/usr/bin/env node
/* eslint-disable no-console */
import { Worker, NativeConnection } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

import { DeployAppActivity } from './activities/DeployAppActivity.js';
import { DestroyAppActivity } from './activities/DestroyAppActivity.js';
import { ResizeDiskActivity } from './activities/ResizeDiskActivity.js';
import { SyncConfigActivity } from './activities/SyncConfigActivity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount';

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
    console.log('[ClusterWorker] In-cluster auth configured');
  } catch (err: any) {
    console.warn('[ClusterWorker] Failed to read service account:', err.message);
  }
}

async function main() {
  await setupInClusterAuth();

  const queue = process.env.TEMPORAL_TASK_QUEUE || 'cluster-ops-queue';
  const address = process.env.TEMPORAL_CONNECTION_ADDRESS || 'localhost:7233';
  console.log(`[ClusterWorker] Starting — taskQueue=${queue}, address=${address}`);

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
        },
        failFast: true,
      });
      break;
    } catch (err: any) {
      console.warn(`[ClusterWorker] ⚠️ Connection to Temporal server failed: ${err.message}. Retrying in 10s...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }

  console.log('[ClusterWorker] ✅ Listening for app deployment tasks');
  await worker.run();
}

main().catch((err) => {
  console.error('[ClusterWorker] FATAL:', err);
  process.exit(1);
});
