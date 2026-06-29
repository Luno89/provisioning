"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClusterProvisionWorkflow = void 0;
const workflow_1 = require("@temporalio/workflow");
/**
 * Typesafe Workflow that triggers a ProvisionClusterActivity.
 *
 * Temporal re-runs this class instance across workflow continuations,
 * retries, and parallel child flows. Every persistence point is tracked server-side.
 */
const logger = (0, workflow_1.workflowLogger)();
const { ProvisionClusterActivity } = (0, workflow_1.proxyActivities)();
class ClusterProvisionWorkflow {
    async execute(args) {
        logger.info(`Starting ClusterProvisionWorkflow for cluster: ${args.name}`);
        try {
            const result = await ProvisionClusterActivity({
                name: args.name,
                provider: args.provider,
                logFile: args.logFile,
            });
            logger.info(`ClusterProvisionWorkflow completed for cluster ${args.name}`);
            return { status: 'healthy', msg: result };
        }
        catch (err) {
            logger.error(`ClusterProvisionWorkflow failed: ${err.message}`);
            return { status: 'failed', msg: err.message || 'Unknown failure' };
        }
    }
}
exports.ClusterProvisionWorkflow = ClusterProvisionWorkflow;
//# sourceMappingURL=ClusterProvisionWorkflow.js.map