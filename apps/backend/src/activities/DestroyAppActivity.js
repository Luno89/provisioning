"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.destroyAppActivityMeta = void 0;
exports.DestroyAppActivity = DestroyAppActivity;
const uuid_1 = require("uuid");
const InfrastructureService_js_1 = require("../services/InfrastructureService.js");
exports.destroyAppActivityMeta = {
    name: 'DestroyAppActivity',
    startToCloseTimeout: '60 minutes',
};
async function DestroyAppActivity(args) {
    const infra = new InfrastructureService_js_1.InfrastructureService();
    const sanitizedName = args.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const stackName = `app-${args.clusterName}-${(0, uuid_1.v4)().slice(0, 8)}`;
    const logFile = args.logFile;
    // 1. CDKTF destroy
    await infra.destroy(stackName, {
        logFile,
        env: {
            STACK_TYPE: 'app',
            CLUSTER_NAME: args.clusterName,
            DEPLOYMENT_STRATEGY: args.strategy,
        },
    });
    // 2. Delete Kubernetes namespace
    const ctx = args.provider === 'k3d' ? `k3d-${args.clusterName}` : undefined;
    await infra.runKubectl(['delete', 'namespace', sanitizedName, '--wait=false']);
    return { status: 'destroyed', msg: `App ${args.name} destroyed` };
}
//# sourceMappingURL=DestroyAppActivity.js.map