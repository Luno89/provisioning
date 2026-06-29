"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const db_js_1 = require("../apps/backend/src/lib/db.js");
const InfrastructureService_js_1 = require("../apps/backend/src/services/InfrastructureService.js");
const ClusterService_js_1 = require("../apps/backend/src/services/ClusterService.js");
const __filename = (0, url_1.fileURLToPath)(import.meta.url);
const __dirname = path_1.default.dirname(__filename);
async function run() {
    console.log('🚀 Initializing services for integration test...');
    const db = new db_js_1.LocalDB();
    await db.init();
    const infra = new InfrastructureService_js_1.InfrastructureService();
    const clusterService = new ClusterService_js_1.ClusterService(db, infra);
    const clusterName = `test-infra-${Math.floor(Math.random() * 1000)}`;
    console.log(`🔨 Provisioning test cluster: ${clusterName}...`);
    let metadata = null;
    let succeeded = false;
    try {
        metadata = await clusterService.provision(clusterName, 'k3d');
        console.log('⏳ Provisioning started in background. Monitoring status...');
        // Poll the status
        for (let i = 0; i < 60; i++) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const clusters = await clusterService.getAll();
            const current = clusters.find(c => c.name === clusterName);
            if (!current) {
                console.log('❌ Cluster not found in database!');
                break;
            }
            console.log(`⏱️ Current status: ${current.status}`);
            if (current.status === 'healthy') {
                succeeded = true;
                break;
            }
            else if (current.status === 'failed') {
                break;
            }
        }
        if (succeeded) {
            console.log('✅ Cluster successfully provisioned!');
        }
        else {
            console.error('❌ Cluster provisioning failed or timed out!');
        }
    }
    catch (err) {
        console.error('❌ Integration test encountered an error during provisioning:', err.message);
    }
    finally {
        console.log(`🧹 Deleting test cluster: ${clusterName}...`);
        try {
            if (metadata && metadata.id) {
                await clusterService.delete(metadata.id);
                // Poll deletion status
                let deleted = false;
                for (let i = 0; i < 40; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                    const clusters = await clusterService.getAll();
                    const current = clusters.find(c => c.name === clusterName);
                    if (!current) {
                        deleted = true;
                        break;
                    }
                    console.log(`⏱️ Deleting status...`);
                }
                if (deleted) {
                    console.log('✨ Cluster successfully deleted and cleaned up.');
                }
                else {
                    console.error('⚠️ Timeout waiting for cluster deletion in database. Forcing physical deletion...');
                    try {
                        await infra.deleteLocalCluster(clusterName);
                    }
                    catch { }
                }
            }
            else {
                console.log('Forcing physical cleanup of cluster nodes...');
                try {
                    await infra.deleteLocalCluster(clusterName);
                }
                catch { }
            }
        }
        catch (cleanupErr) {
            console.error('❌ Error during cleanup:', cleanupErr.message);
        }
        // Exit with appropriate status code
        process.exit(succeeded ? 0 : 1);
    }
}
run();
//# sourceMappingURL=infra-integration.js.map