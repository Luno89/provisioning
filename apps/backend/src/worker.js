#!/usr/bin/env node
"use strict";
/* eslint-disable no-console */
/**
 * Temporal Worker Entrypoint.
 *
 * This script starts the long-running worker that picks up tasks from the
 * "provisioning-ops-queue" and executes the cluster/app provisioning workflows
 * using @temporalio/worker + @temporalio/proto.
 *
 * Prerequisite:
 *   Temporal server must be running on port 7233 (see docker-compose.temporal.yml
 *   or Temporal Cloud connection config).
 *
 * Run via:  npm run dev:worker
 */
Object.defineProperty(exports, "__esModule", { value: true });
const worker_1 = require("@temporalio/worker");
require("./workflows/ClusterProvisionWorkflow.js");
require("./workflows/DestroyClusterWorkflow.js");
require("./workflows/AppDeployWorkflow.js");
require("./workflows/DestroyAppWorkflow.js");
require("./workflows/ResizeDiskWorkflow.js");
const queue = process.env.TEMPORAL_TASK_QUEUE || 'provisioning-ops-queue';
const serverUri = process.env.TEMPORAL_CONNECTION_ADDRESS || 'localhost:7233';
const WORKFLOW_ROOT = new URL('./src/workflows', import.meta.url);
const ACTIVITY_ROOT = new URL('./src/activities', import.meta.url);
async function main() {
    console.log(`🚀 Temporal worker starting (queue=${queue}, server=${serverUri})`);
    const worker = new worker_1.Worker({
        taskQueue: queue,
        failFast: true,
    });
    // Register all declared workflows + activities
    await worker.start({
        workflowsPath: WORKFLOW_ROOT,
        activitiesPath: ACTIVITY_ROOT,
        defaultTimeout: '900s',
    });
    console.log('✅ Worker up. Listening for tasks on', queue);
    await worker.run();
}
main().catch((err) => {
    console.error('FATAL worker error:', err);
    process.exit(1);
});
//# sourceMappingURL=worker.js.map