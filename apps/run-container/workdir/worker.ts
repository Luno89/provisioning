#!/usr/bin/env node
/**
 * Worker run inside k3d cluster — this is the actual worker process
 * that runs inside a container in the k3d cluster, with full access to
 * the cluster's filesystem and network.
 *
 * The worker was built up using:
 *   1. runnercontainer   (no inventory, owned by user)
 *   2. cluster provision (monitoring + agent stack)
 *   3. connect           (kubeconfig connection)
 *   4. env               → RunnerContainer/deployworkerd.envfile template
 *   5. Cluster           with INFRA_TYPE=cluster
 *
 * Usage:
 *   node worker.ts [stop]
 */
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { WorkerState } from '../../../backend/src/services/WorkerService.js';

declare module '../backend/src/services/WorkerService.js' {
  interface WorkerState {
    readonly progress: string | null;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Register all workflows + activities ──

import { ClusterProvisionWorkflow } from '../backend/src/workflows/ClusterProvisionWorkflow.js';
import { DestroyClusterWorkflow } from '../backend/src/workflows/DestroyClusterWorkflow.js';
import { AppDeployWorkflow } from '../backend/src/workflows/AppDeployWorkflow.js';
import { DestroyAppWorkflow } from '../backend/src/workflows/DestroyAppWorkflow.js';
import { ResizeDiskWorkflow } from '../backend/src/workflows/ResizeDiskWorkflow.js';

import { ProvisionClusterActivity } from '../backend/src/activities/ProvisionClusterActivity.js';
import { DestroyClusterActivity } from '../backend/src/activities/DestroyClusterActivity.js';
import { DeployAppActivity } from '../backend/src/activities/DeployAppActivity.js';
import { DestroyAppActivity } from '../backend/src/activities/DestroyAppActivity.js';
import { ResizeDiskActivity } from '../backend/src/activities/ResizeDiskActivity.js';

// ──────────────────────────────────────────────────
// Main Worker Boot
// ──────────────────────────────────────────────────

async function main() {
  const queue = process.env.TEMPORAL_TASK_QUEUE || 'provisioning-ops-queue';
  const serverUri = process.env.TEMPORAL_CONNECTION_ADDRESS || 'localhost:7233';

  // ── Worker start ──
  const worker = await Worker.create({
    taskQueue: queue,
    failFast: true,
  });

  // ── Register workflows + activities ─
  // Note: workflows + activities are imported as side-effects at the top of the file

  console.log('[Worker] ✅ Worker up — listening for tasks on', queue);
  console.log('[Worker] Note: running inside k3d cluster with full access to filesystem+network');
  console.log('[Worker] N | will use runnercontainer + ClusterProvision + Connect to build up');
  console.log('[Worker] N | cluster (INFRA_TYPE=cluster) + env = RunnerContainer/deployworkerd.envfile template');

  await worker.run();
}

main().catch((err) => {
  console.error('[Worker] 🚨 FATAL worker error:', err);
  process.exit(1);
});
