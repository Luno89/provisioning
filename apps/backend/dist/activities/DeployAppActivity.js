"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deployAppActivityMeta = void 0;
exports.DeployAppActivity = DeployAppActivity;
const path_1 = __importDefault(require("path"));
const uuid_1 = require("uuid");
const InfrastructureService_js_1 = require("../services/InfrastructureService.js");
const BuilderService_js_1 = require("../services/BuilderService.js");
const StorageAdapter_js_1 = require("../services/StorageAdapter.js");
exports.deployAppActivityMeta = {
    name: 'DeployAppActivity',
    startToCloseTimeout: '80 minutes',
};
const SANITIZE = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const LIVE_ROOT = path_1.default.resolve(__dirname, '../../..');
async function DeployAppActivity(args) {
    const infra = new InfrastructureService_js_1.InfrastructureService();
    const builder = new BuilderService_js_1.BuilderService({}, infra);
    const logFile = args.logFile;
    const sanitizedName = SANITIZE(args.name);
    const finalOdooRepo = args.odooRepo || `odoo:latest`;
    const finalOdooTag = args.odooTag || '18.0';
    let customImageTag;
    // ── 1. Build custom image if modules are selected ──
    if (args.modules && args.modules.length > 0) {
        customImageTag = await builder.buildCustomImage(args.odooRepo || `odoo:latest`, args.modules, args.appType, { logFile, resourceId: args.clusterId });
        if (customImageTag) {
            await infra.importImage(args.clusterName, customImageTag, { logFile });
            const [repo, imageTag] = customImageTag.split(':');
            finalOdooRepo = repo || finalOdooRepo;
            finalOdooTag = imageTag || finalOdooTag;
        }
    }
    // ── 2. Get kubeconfig for k3d clusters ──
    const kubeconfigPath = args.provider === 'k3d'
        ? `/tmp/kubeconfig-${args.clusterName}`
        : path_1.default.join(LIVE_ROOT, '.kube/config');
    const storageEnv = StorageAdapter_js_1.StorageAdapter.getStorageEnv(args.appType, args.strategy, {});
    const displayUrl = args.appType === 'odoo'
        ? 'http://localhost:8069'
        : 'http://localhost:80';
    const env = {
        STACK_TYPE: 'app',
        CLUSTER_NAME: args.clusterName,
        DEPLOYMENT_STRATEGY: args.strategy,
        DEPLOYMENT_NAME: sanitizedName,
        DEPLOYMENT_ID: (0, uuid_1.v4)().slice(0, 8),
        KUBECONFIG: kubeconfigPath,
        KUBECONFIG_CONTEXT: args.provider === 'k3d' ? `k3d-${args.clusterName}` : '',
        APP_TYPE: args.appType,
        WEB_IMAGE_REPO: finalOdooRepo || '',
        WEB_IMAGE_TAG: finalOdooTag || '',
        DB_IMAGE_REPO: args.dbRepo || '',
        DB_IMAGE_TAG: args.dbTag || '',
        VPN_ENABLED: 'false',
        VPN_PROTOCOL: 'wireguard',
        VPN_CONFIG: '',
        VPN_DEDICATED_IP: '',
        ODOO_IMAGE_REPO: finalOdooRepo || '',
        ODOO_IMAGE_TAG: finalOdooTag || '',
        POSTGRES_IMAGE_REPO: args.dbRepo || '',
        POSTGRES_IMAGE_TAG: args.dbTag || '',
        ...storageEnv,
    };
    await infra.deploy(`app-${args.clusterName}-${(0, uuid_1.v4)().slice(0, 8)}`, { logFile, env });
    return {
        status: 'running',
        msg: `App ${args.appType}/${args.name} deployed`,
        displayUrl,
    };
}
//# sourceMappingURL=DeployAppActivity.js.map