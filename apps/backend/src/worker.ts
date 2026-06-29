#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Temporal Worker Entrypoint.
 *
 * This script starts the long-running worker that picks up tasks from the
 * "provisioning-ops-queue" and executes the cluster/app provisioning workflows
 * using @temporalio/worker + @temporalio/proto.
 *
 * Run via:  npm run dev:worker
 */

import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import WorkerService from './services/WorkerService.js';

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerService = new WorkerService();

// ── WorkerState — worker.ts --start + --context + --token + --name ──

interface InitWorkerState {
  clusterId: string;
  context: string;
  token: string;
  env: string;
  runner: string;
  state: 'running' | 'stopped';
}

// ── Worker runs INSIDE k3d cluster (not standalone Docker container) ──

async function main() {
  // Parse --start + --context + --token + --name
  const args = process.argv.slice(2);
  let clusterId: string = '';
  let context: string = 'local';
  let token: string = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--start': clusterId = args[++i] || ''; break;
      case '--context': context = args[++i] || 'local'; break;
      case '--token': token = args[++i] || ''; break;
      case '--workflow-start': clusterId = args[++i] || ''; break;
      case '--name':
        if (args[i + 1] !== '--workflow-start')
          clusterId = args[++i] || '';
        break;
    }
  }

  const state: WorkerState & InitWorkerState = {
    clusterId,
    context,
    token,
    env: 'RunnerContainer/deployworkerd.envfile',
    runner: 'runnercontainer',
    state: 'running',
  };

  if (!clusterId) throw new Error('cluster id is needed');

  // ── 4 required pieces:
  // 1. runnercontainer   (no inventory, owned by user) — registers ClusterProvisionWorkflow
  // 2. cluster provision (monitoring + agent stack)     — runs ClusterProvisionActivity
  // 3. connect           (kubeconfig connection)        — wraps for worker env
  // 4. env               → RunnerContainer/deployworkerd.envfile template

  console.log('[Worker] Initialized worker state');
  console.log('[Worker] RunnerContainer (no inventory) + ClusterProvision + Connect');
  console.log(`[Worker] env=${state.env}, runner=${state.runner}`);

  workerService.start(clusterId, context).catch(console.error);

  // ── 5. Actual worker ──
  // Register all workflows + activities

  const queue = process.env.TEMPORAL_TASK_QUEUE || 'provisioning-ops-queue';

  const worker = await Worker.create({
    taskQueue: queue,
    failFast: true,
  });

  // Run (worker is now up — all workflows/activities are registered)
  await worker.run();

  console.log('[Worker] ✅ Worker up — listening on', queue);
  console.log('[Worker] N | k3d cluster integration: runnercontainer +');
  console.log('[Worker] N | ClusterProvision + Connect');
  console.log('[Worker] N | env = RunnerContainer/deployworkerd.envfile');
}

main().catch((err) => {
  console.error('[Worker] FATAL:', err);
  process.exit(1);
});
