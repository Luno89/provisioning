"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeResizeDiskWorkflow = executeResizeDiskWorkflow;
/**
 * ResizeDiskWorkflow - orchestrates disk resizing for a specific deployment.
 */
const workflow_1 = require("@temporalio/workflow");
const { ResizeDiskActivity } = (0, workflow_1.proxyActivities)({ startToCloseTimeout: '30 minutes' });
async function executeResizeDiskWorkflow(args) {
    return ResizeDiskActivity(args);
}
//# sourceMappingURL=ResizeDiskWorkflow.js.map