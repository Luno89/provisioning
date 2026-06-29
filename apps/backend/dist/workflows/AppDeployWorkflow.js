"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeDeployAppWorkflow = executeDeployAppWorkflow;
const workflow_1 = require("@temporalio/workflow");
const { DeployAppActivity } = (0, workflow_1.proxyActivities)();
async function executeDeployAppWorkflow(args) {
    return DeployAppActivity(args);
}
//# sourceMappingURL=AppDeployWorkflow.js.map