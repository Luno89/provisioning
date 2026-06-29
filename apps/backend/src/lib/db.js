"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalDB = void 0;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const uuid_1 = require("uuid");
const __filename = (0, url_1.fileURLToPath)(import.meta.url);
const __dirname = path_1.default.dirname(__filename);
const DATA_DIR = path_1.default.join(__dirname, '../../data');
class LocalDB {
    isTest = process.env.NODE_ENV === 'test' || process.env.IS_E2E === 'true';
    clustersPath = path_1.default.join(DATA_DIR, `${this.isTest ? 'clusters-test' : 'clusters'}.json`);
    deploymentsPath = path_1.default.join(DATA_DIR, `${this.isTest ? 'deployments-test' : 'deployments'}.json`);
    async init() {
        await promises_1.default.mkdir(DATA_DIR, { recursive: true });
        if (!(await this.exists(this.clustersPath)))
            await promises_1.default.writeFile(this.clustersPath, '[]');
        if (!(await this.exists(this.deploymentsPath)))
            await promises_1.default.writeFile(this.deploymentsPath, '[]');
    }
    async exists(filePath) {
        try {
            await promises_1.default.access(filePath);
            return true;
        }
        catch {
            return false;
        }
    }
    async getClusters() {
        const data = await promises_1.default.readFile(this.clustersPath, 'utf-8');
        const parsed = JSON.parse(data);
        return parsed || [];
    }
    async saveCluster(cluster) {
        const clusters = await this.getClusters();
        const idx = clusters.findIndex(c => c.id === cluster.id);
        if (idx >= 0)
            clusters[idx] = cluster;
        else
            clusters.push(cluster);
        await promises_1.default.writeFile(this.clustersPath, JSON.stringify(clusters, null, 2));
    }
    async saveClusterList(clusters) {
        await promises_1.default.writeFile(this.clustersPath, JSON.stringify(clusters, null, 2));
    }
    async getDeployments() {
        const data = await promises_1.default.readFile(this.deploymentsPath, 'utf-8');
        const parsed = JSON.parse(data);
        return parsed || [];
    }
    async saveDeployment(deployment) {
        const deployments = await this.getDeployments();
        const idx = deployments.findIndex(d => d.id === deployment.id);
        if (idx >= 0)
            deployments[idx] = deployment;
        else
            deployments.push(deployment);
        await promises_1.default.writeFile(this.deploymentsPath, JSON.stringify(deployments, null, 2));
    }
    async saveDeploymentList(deployments) {
        await promises_1.default.writeFile(this.deploymentsPath, JSON.stringify(deployments, null, 2));
    }
    /**
     * Create a new cluster entry (used by TemporalService on workflow kickoff).
     */
    async saveClusterInfo(cluster) {
        const c = {
            id: cluster.id || (0, uuid_1.v4)(),
            name: cluster.name || '',
            provider: cluster.provider || 'k3d',
            status: cluster.status || 'provisioning',
            kubeconfigPath: cluster.kubeconfigPath ?? undefined,
            lastLogPath: cluster.lastLogPath ?? undefined,
            temporalWorkflowId: cluster.temporalWorkflowId ?? undefined,
        };
        await this.saveCluster(c);
        return c;
    }
    async saveDeploymentInfo(deployment) {
        const d = {
            id: deployment.id || (0, uuid_1.v4)(),
            name: deployment.name || '',
            clusterId: deployment.clusterId || '',
            strategy: deployment.strategy || 'helm',
            appType: deployment.appType ?? undefined,
            status: deployment.status || 'deploying',
            webRepo: deployment.webRepo,
            webTag: deployment.webTag,
            dbRepo: deployment.dbRepo,
            dbTag: deployment.dbTag,
            url: deployment.url,
            isExposed: deployment.isExposed,
            exposureUrl: deployment.exposureUrl,
            lastLogPath: deployment.lastLogPath,
            modules: deployment.modules,
            storage: deployment.storage,
            vpnEnabled: deployment.vpnEnabled,
            vpnProtocol: deployment.vpnProtocol,
            vpnConfig: deployment.vpnConfig,
            vpnDedicatedIp: deployment.vpnDedicatedIp,
            temporalWorkflowId: deployment.temporalWorkflowId,
        };
        await this.saveDeployment(d);
        return d;
    }
}
exports.LocalDB = LocalDB;
//# sourceMappingURL=db.js.map