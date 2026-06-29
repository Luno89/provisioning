#!/usr/bin/env node
/**
 * worker-entrypoint.ts — The actual Worker Entry Point.
 *
 * This is the actual worker run inside a container in the k3d cluster. It:
 *   1. Uses `runnercontainer` (no inventory, owned by user) — registers all workflows + activities
 *   2. Uses `ClusterProvision` (monitoring + agent stack) — uses ClusterProvisionWorkflow
 *   3. Uses `Connect` (kubeconfig connection) — wraps the cluster for worker env
 *   4. Sets env to the worker deploy path
 *   5. Creates `Cluster` with `INFRA_TYPE=cluster`
 *
 * The worker is now running in the k3d cluster container, with full access
 * to the cluster's filesystem and network.
 */
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Register all workflows + activities ──

import { ClusterProvisionWorkflow } from './workflows/ClusterProvisionWorkflow.js';
import { DestroyClusterWorkflow } from './workflows/DestroyClusterWorkflow.js';
import { AppDeployWorkflow } from './workflows/AppDeployWorkflow.js';
import { DestroyAppWorkflow } from './workflows/DestroyAppWorkflow.js';
import { ResizeDiskWorkflow } from './workflows/ResizeDiskWorkflow.js';

import { ProvisionClusterActivity } from './activities/ProvisionClusterActivity.js';
import { DestroyClusterActivity } from './activities/DestroyClusterActivity.js';
import { DeployAppActivity } from './activities/DeployAppActivity.js';
import { DestroyAppActivity } from './activities/DestroyAppActivity.js';
import { ResizeDiskActivity } from './activities/ResizeDiskActivity.js';

// ─── WorkerState ──

export interface WorkerState {
  readonly state: 'running' | 'stopped' | 'error';
  readonly clusterId: string;
  readonly clusterName: string;
  readonly context: string;
}

// ─── Main ──

async function main() {
  // 1. runnercontainer (no inventory, owned by user) — imports all workflows/activities
  // 2. ClusterProvision — registers ClusterProvisionWorkflow
  // 3. Connect (kubeconfig) — wraps for worker env
  // 4. env → RunnerContainer/deployworkerd.envfile

  const worker = await Worker.create({
    taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'provisioning-ops-queue',
    failFast: true,
  });

  // Register workflows + activities
  await worker.run({
    workflowsPath: new URL('./workflows', import.meta.url),
    activitiesPath: new URL('./activities', import.meta.url),
    defaultTimeout: '900s',
  });

  console.log('✅ Worker up. Listening for tasks on provisioning-ops-queue');
  await worker.run();
}

main().catch((err) => {
  console.error('FATAL worker error:', err.stack);
  process.exit(1);
});

  console.log('✅ Worker up. Listening for tasks on provisioning-ops-queue');
  await worker.run();
}

main().catch((err) => {
  console.error('FATAL worker error:', err);
  process.exit(1);
});
