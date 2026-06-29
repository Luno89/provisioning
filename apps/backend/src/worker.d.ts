#!/usr/bin/env node
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
import './workflows/ClusterProvisionWorkflow.js';
import './workflows/DestroyClusterWorkflow.js';
import './workflows/AppDeployWorkflow.js';
import './workflows/DestroyAppWorkflow.js';
import './workflows/ResizeDiskWorkflow.js';
//# sourceMappingURL=worker.d.ts.map