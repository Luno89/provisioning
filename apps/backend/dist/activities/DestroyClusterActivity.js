"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.destroyClusterActivityMeta = void 0;
exports.DestroyClusterActivity = DestroyClusterActivity;
/**
 * DestroyClusterActivity
 *
 * Destroys the physical k3d cluster, runs any remaining CDKTF destroy,
 * and cleans up kubeconfig leftovers.
 */
const promises_1 = __importDefault(require("fs/promises"));
const InfrastructureService_js_1 = require("../services/InfrastructureService.js");
exports.destroyClusterActivityMeta = {
    name: 'DestroyClusterActivity',
    startToCloseTimeout: '60 minutes',
};
async function DestroyClusterActivity(args) {
    const infra = new InfrastructureService_js_1.InfrastructureService();
    const logFile = args.logFile;
    // 1. Destroy infrastructure stack
    await infra.destroy(args.name, {
        logFile,
        env: {
            STACK_TYPE: 'cluster',
            ENV: args.provider,
            CLUSTER_NAME: args.name,
        },
    });
    // 2. Delete the physical k3d cluster if applicable
    if (args.provider === 'k3d') {
        await infra.deleteLocalCluster(args.name, { logFile });
        try {
            await promises_1.default.rm(`/tmp/kubeconfig-${args.name}`, { force: true });
        }
        catch { }
    }
    return { status: 'destroyed', msg: `Cluster ${args.name} destroyed` };
}
//# sourceMappingURL=DestroyClusterActivity.js.map