"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeDestroyAppWorkflow = executeDestroyAppWorkflow;
/**
 * DestroyAppWorkflow
 *
 * Orchestrates the lifecycle of an application destruction (CDKTF destroy
 * + Kubernetes namespace deletion).
 */
const workflow_1 = require("@temporalio/workflow");
const { DestroyAppActivity } = (0, workflow_1.proxyActivities)({ startToCloseTimeout: '30 minutes' });
async function executeDestroyAppWorkflow(args) {
    return DestroyAppActivity(args);
}
//# sourceMappingURL=DestroyAppWorkflow.js.map