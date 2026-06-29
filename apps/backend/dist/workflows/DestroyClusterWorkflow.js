"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeDestroyClusterWorkflow = executeDestroyClusterWorkflow;
/**
 * DestroyClusterWorkflow
 *
 * Orchestrates the lifecycle of a cluster destruction: triggers
 * DestroyClusterActivity and waits for completion.
 */
const workflow_1 = require("@temporalio/workflow");
const { DestroyClusterActivity } = (0, workflow_1.proxyActivities)();
async function executeDestroyClusterWorkflow(args) {
    const result = await DestroyClusterActivity(args);
    return result;
}
//# sourceMappingURL=DestroyClusterWorkflow.js.map