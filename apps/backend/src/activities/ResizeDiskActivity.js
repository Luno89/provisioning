"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resizeDiskActivityMeta = void 0;
exports.ResizeDiskActivity = ResizeDiskActivity;
const uuid_1 = require("uuid");
const InfrastructureService_js_1 = require("../services/InfrastructureService.js");
const StorageAdapter_js_1 = require("../services/StorageAdapter.js");
exports.resizeDiskActivityMeta = {
    name: 'ResizeDiskActivity',
    startToCloseTimeout: '80 minutes',
};
async function ResizeDiskActivity(args) {
    const infra = new InfrastructureService_js_1.InfrastructureService();
    const logFile = args.logFile;
    const kubeconfigPath = args.provider === 'k3d' ? `/tmp/kubeconfig-${args.clusterName}` : undefined;
    const storageEnv = StorageAdapter_js_1.StorageAdapter.getStorageEnv(args.appType, args.strategy, args.storage);
    const env = {
        STACK_TYPE: 'app',
        CLUSTER_NAME: args.clusterName,
        DEPLOYMENT_STRATEGY: args.strategy,
        DEPLOYMENT_NAME: args.name.toLowerCase().replace(/[^a-z0-9]*/g, '-'),
        DEPLOYMENT_ID: (0, uuid_1.v4)().slice(0, 8),
        KUBECONFIG: kubeconfigPath || '',
        KUBECONFIG_CONTEXT: args.provider === 'k3d' ? `k3d-${args.clusterName}` : '',
        APP_TYPE: args.appType,
        ...storageEnv,
    };
    await infra.deploy(`app-${args.clusterName}-${(0, uuid_1.v4)().slice(0, 8)}`, { logFile, env });
    return { status: 'resize_complete', msg: `Disk resize requested for ${args.name}` };
}
//# sourceMappingURL=ResizeDiskActivity.js.map