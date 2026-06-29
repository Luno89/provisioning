"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemporalBridge = exports.connectToTemporal = void 0;
/**
 * Temporal Bridge - bridges Express routes ↔ Temporal workflow execution.
 *
 * All provisioning / deployment mutations go through this bridge, replacing the
 * original inline setTimeout() loops with Temporal's workflow persistence engine.
 */
const client_1 = require("@temporalio/client");
const queue = 'provisioning-ops-queue';
const connectToTemporal = async (address) => {
    const c = new client_1.Client({});
    return c;
};
exports.connectToTemporal = connectToTemporal;
class TemporalBridge {
    client;
    _initialized = false;
    db;
    constructor(db) {
        this.db = db;
    }
    isInitialized() { return this._initialized; }
    async start() {
        if (this._initialized)
            return this;
        try {
            this.client = new client_1.Client({});
            this._initialized = true;
        }
        catch (e) {
            console.warn('⚠️ Temporal bridge start failed:', e.message);
            return this;
        }
        return this;
    }
    async flush() {
        try {
            await this.client.start();
        }
        catch { }
    }
    async stop() {
        if (this._initialized) {
            try {
                await this.client.close();
            }
            catch { }
        }
        this._initialized = false;
    }
    async waitForStatus(workflowId) {
        await this.client.startWorkflow(workflowId, {
            taskQueue: queue,
            args: { workflowId: workflowId },
        });
        return undefined;
    }
    // ──── Cluster lifecycle ────────────────────────────────────────────────
    async provision(clusterName, provider) {
        const workflowId = `cluster-provision-${clusterName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const handle = await this.client.startWorkflow(workflowId, {
            taskQueue: queue,
            args: { workflowId: workflowId, name: clusterName, provider, logFile: `${Date.now()}-${Math.random().toString(36).slice(2)}-A1.log` },
        });
        await this.db.saveClusterInfo({ name: clusterName, provider, status: 'provisioning', temporalWorkflowId: workflowId });
        return {
            id: workflowId,
            handle,
            promise: handle.result(),
            workflowEvent: 'cluster-provision',
            workflowEncoded: workflowId,
        };
    }
    async destroyCluster(clusterId) {
        const cluster = (this.db.getClusters()).find((c) => c.id === clusterId);
        if (!cluster)
            throw new Error('ClusterMetadata not found');
        const workflowId = `cluster-destroy-${cluster.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const handle = await this.client.startWorkflow(workflowId, {
            taskQueue: queue,
            args: { workflowId: workflowId, name: cluster.name, provider: cluster.provider, logFile: `${Date.now()}-destroy-${Math.random().toString(36).slice(2)}-B2.log` },
        });
        (await this.db.saveClusterInfo({ ...cluster, status: 'destroying', temporalWorkflowId: workflowId }));
        return {
            id: workflowId,
            handle,
            promise: handle.result(),
            workflowEvent: 'cluster-destroy',
            workflowEncoded: workflowId,
        };
    }
    async onClusterStatus(query) {
        return await this.db.getClusters();
    }
    // ──── App lifecycle ────────────────────────────────────────────────────
    async deployApp(args) {
        const workflowId = `app-deploy-${args.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const handle = await this.client.startWorkflow(workflowId, {
            taskQueue: queue,
            args: {
                workflowId: workflowId,
                name: args.name,
                clusterId: args.clusterId,
                strategy: args.strategy || 'helm',
                appType: args.appType,
                modules: args.modules,
                odooRepo: args.odooRepo || 'library/odoo',
                odooTag: args.odooTag || '18.0',
                dbRepo: args.dbRepo || 'library/postgres',
                dbTag: args.dbTag || 'latest',
                logFile: `${Date.now()}-${Math.random().toString(36).slice(2)}-C3.log`,
            },
        });
        const dep = await this.db.saveDeploymentInfo({
            name: args.name,
            clusterId: args.clusterId,
            strategy: args.strategy || 'helm',
            appType: args.appType,
            status: 'deploying',
            modules: args.modules,
            temporalWorkflowId: workflowId,
        });
        return {
            id: workflowId,
            handle,
            promise: handle.result(),
            workflowEvent: 'app-deploy',
            workflowEncoded: workflowId,
        };
    }
    async destroyApp(deploymentId) {
        const dep = (this.db.getDeployments()).find((d) => d.id === deploymentId);
        if (!dep)
            throw new Error('DeploymentMetadata not found');
        const workflowId = `app-destroy-${dep.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const handle = await this.client.startWorkflow(workflowId, {
            taskQueue: queue,
            args: {
                workflowId: workflowId,
                name: dep.name,
                clusterId: dep.clusterId,
                strategy: dep.strategy,
                logFile: `${Date.now()}-${Math.random().toString(36).slice(2)}-D4.log`,
            },
        });
        await this.db.saveDeploymentInfo({ ...dep, status: 'destroying', temporalWorkflowId: workflowId });
        return {
            id: workflowId,
            handle,
            promise: handle.result(),
            workflowEvent: 'app-destroy',
            workflowEncoded: workflowId,
        };
    }
    // ──── Resize ────────────────────────────────────────────────────────────
    async resizeDisk(id, storage) {
        const dep = (this.db.getDeployments()).find((d) => d.id === id);
        if (!dep)
            throw new Error('DeploymentMetadata not found (resize)');
        const workflowId = `resize-${dep.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const handle = await this.client.startWorkflow(workflowId, {
            taskQueue: queue,
            args: {
                workflowId: workflowId,
                name: dep.name,
                clusterId: dep.clusterId,
                strategy: dep.strategy,
                appType: dep.appType || 'odoo',
                storage,
                logFile: `${Date.now()}-${Math.random().toString(36).slice(2)}-E5.log`,
            },
        });
        await this.db.saveDeploymentInfo({ ...dep, storage, status: 'deploying', temporalWorkflowId: workflowId });
        return {
            id: workflowId,
            handle,
            promise: handle.result(),
            workflowEvent: 'disk-resize',
            workflowEncoded: workflowId,
        };
    }
}
exports.TemporalBridge = TemporalBridge;
//# sourceMappingURL=TemporalBridge.js.map