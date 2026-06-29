"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrap = bootstrap;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const http_1 = require("http");
const __filename = (0, url_1.fileURLToPath)(import.meta.url);
const __dirname = path_1.default.dirname(__filename);
const socket_io_1 = require("socket.io");
// Library Imports
const db_js_1 = require("./lib/db.js");
// Service Imports
const InfrastructureService_js_1 = require("./services/InfrastructureService.js");
const ClusterService_js_1 = require("./services/ClusterService.js");
const AppService_js_1 = require("./services/AppService.js");
const RegistryService_js_1 = require("./services/RegistryService.js");
const GitModuleService_js_1 = require("./services/GitModuleService.js");
const BuilderService_js_1 = require("./services/BuilderService.js");
const AppExposureService_js_1 = require("./services/AppExposureService.js");
const TemporalBridge_js_1 = require("./services/TemporalBridge.js");
const net_1 = __importDefault(require("net"));
const child_process_1 = require("child_process");
dotenv_1.default.config();
function startHostTunnel(port = 8000) {
    const server = net_1.default.createServer((socket) => {
        const child = (0, child_process_1.spawn)('docker', ['exec', '-i', 'provisioner-nginx', 'nc', '127.0.0.1', '80']);
        socket.pipe(child.stdin);
        child.stdout.pipe(socket);
        socket.on('error', () => child.kill());
        child.on('error', () => socket.destroy());
        socket.on('close', () => child.kill());
        child.on('close', () => socket.destroy());
    });
    server.on('error', (err) => {
        console.error(`Host tunnel server error: ${err.message}`);
    });
    server.listen(port, '0.0.0.0', () => {
        console.log(`🚀 Host Tunnel Server active on http://0.0.0.0:${port}`);
    });
}
const DEFAULT_LOG_LEVEL = 50;
/**
 * APPLICATION BOOTSTRAP
 *
 * The side-channel `TemporalBridge` is used by mutating API routes to route
 * through the long-lived Temporal workflow persistence engine.  All other
 * reads stay on the Local DB so they don't block until the workflow ends.
 */
async function bootstrap() {
    const app = (0, express_1.default)();
    const httpServer = (0, http_1.createServer)(app);
    const io = new socket_io_1.Server(httpServer, { cors: { origin: '*' } });
    const port = process.env.PORT || 3001;
    // ── 1. Initialize backend ────────────────────────────────────────────────
    const db = new db_js_1.LocalDB();
    await db.init();
    const infraService = new InfrastructureService_js_1.InfrastructureService();
    const builderService = new BuilderService_js_1.BuilderService(db, infraService);
    const clusterService = new ClusterService_js_1.ClusterService(db, infraService);
    const appService = new AppService_js_1.AppService(db, infraService, clusterService, builderService);
    const registryService = new RegistryService_js_1.RegistryService(db);
    const gitModuleService = new GitModuleService_js_1.GitModuleService(db);
    const appExposureService = new AppExposureService_js_1.AppExposureService(db, infraService, clusterService);
    // ── 2. Temporal bridge (HTTP only → sketch → poll DB) ────────────────────
    const temporalBridge = new TemporalBridge_js_1.TemporalBridge(db);
    try {
        await temporalBridge.start();
    }
    catch (e) {
        // If Temporal is not reachable, serve the same UI with normal polling
        console.warn(`⚠️ Temporal TS bridge not available. Routes will fall back to Local DB.`, e.message);
    }
    app.use((0, cors_1.default)());
    app.use(express_1.default.json());
    // ── 3. SOCKET.IO ORCHESTRATION ───────────────────────────────────────────
    io.on('connection', (socket) => {
        socket.on('join-room', (id) => socket.join(id));
        socket.on('join-kube-room', (id) => socket.join(`${id}-kube`));
        socket.on('tail-pod', async ({ resourceId, podName, namespace }) => {
            const deployments = await appService.getAll();
            const dep = deployments.find(d => d.id === resourceId);
            let context;
            let kubeconfigPath;
            if (dep) {
                const cluster = await clusterService.getById(dep.clusterId);
                if (cluster) {
                    if (cluster.provider === 'k3d')
                        context = `k3d-${cluster.name}`;
                    kubeconfigPath = await clusterService.getKubeconfigPath(cluster);
                }
            }
            const args = ['logs', '-n', namespace || 'default', podName, '--tail=100', '-f'];
            if (context)
                args.push('--context', context);
            infraService.streamLogs(resourceId, args, io, `${resourceId}-kube`, kubeconfigPath);
        });
        socket.on('leave-room', (id) => socket.leave(id));
        socket.on('leave-kube-room', (id) => { socket.leave(`${id}-kube`); infraService.stopStream(id); });
    });
    // ── 4. ROUTES ────────────────────────────────────────────────────────────
    /** ── CLUSTERS ── */
    app.get('/api/clusters', async (req, res) => res.json(await clusterService.getAll(io)));
    app.post('/api/clusters', async (req, res) => {
        try {
            const info = await temporalBridge.provision(req.body.name, req.body.provider);
            res.status(202).json({
                message: 'Provisioning started',
                clusterName: req.body.name,
                provider: req.body.provider,
                workflowId: info.id,
                state: 'running',
            });
        }
        catch (err) {
            res.status(503).json({ error: `Temporal cluster provisioning unavailable: ${err.message}` });
        }
    });
    app.delete('/api/clusters/:id', async (req, res) => {
        try {
            const info = await temporalBridge.destroyCluster(req.params.id);
            res.status(202).json({
                message: 'Destroying cluster',
                clusterId: req.params.id,
                workflowId: info.id,
                state: 'running',
            });
        }
        catch (err) {
            res.status(503).json({ error: `Temporal cluster destroy unavailable: ${err.message}` });
        }
    });
    app.get('/api/clusters/:id/all-pods', async (req, res) => res.json(await clusterService.listAllPods(req.params.id)));
    app.get('/api/clusters/:id/helm-releases', async (req, res) => res.json(await clusterService.listReleases(req.params.id)));
    /** ── DEPLOYMENTS ── */
    app.get('/api/deployments', async (req, res) => res.json(await appService.getAll(io)));
    app.post('/api/deployments', async (req, res) => {
        try {
            const info = await temporalBridge.deployApp(req.body);
            // Persist deployment row with status=running
            const dep = {
                id: req.body.name,
                name: req.body.name,
                clusterId: req.body.clusterId,
                strategy: req.body.strategy || 'helm',
                appType: req.body.appType,
                status: 'running',
                modules: req.body.modules,
                storage: req.body.storage,
                url: req.body.url,
                temporalWorkflowId: info.id,
            };
            await db.saveDeployment(dep);
            res.status(202).json({
                message: 'Deployment started',
                deploymentName: req.body.name,
                workflowId: info.id,
                state: 'running',
            });
        }
        catch (err) {
            res.status(503).json({ error: `Temporal app deploy unavailable: ${err.message}` });
        }
    });
    app.delete('/api/deployments/:id', async (req, res) => {
        try {
            const info = await temporalBridge.destroyApp(req.params.id);
            res.status(202).json({
                message: 'Destroying app',
                deploymentId: req.params.id,
                workflowId: info.id,
                state: 'running',
            });
        }
        catch (err) {
            res.status(503).json({ error: `Temporal app destroy unavailable: ${err.message}` });
        }
    });
    app.get('/api/deployments/:id/helm', async (req, res) => res.json({ content: await appService.getHelmStatus(req.params.id) }));
    app.get('/api/deployments/:id/diagnostics', async (req, res) => res.json({ content: await appService.getDiagnostics(req.params.id) }));
    app.get('/api/deployments/:id/pods', async (req, res) => {
        try {
            res.json(await appService.listPods(req.params.id));
        }
        catch {
            res.status(500).json({ error: 'Failed to list pods' });
        }
    });
    app.post('/api/deployments/:id/expose', async (req, res) => {
        try {
            res.json(await appExposureService.expose(req.params.id));
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/deployments/:id/unexpose', async (req, res) => {
        try {
            res.json(await appExposureService.unexpose(req.params.id));
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    /** ── MODULES ── */
    app.get('/api/modules', async (req, res) => res.json(await gitModuleService.listAvailableModules(req.query.appType)));
    app.patch('/api/deployments/:id/modules', async (req, res) => {
        const { modules } = req.body;
        res.status(202).json(await appService.updateModules(req.params.id, modules, io));
    });
    app.patch('/api/deployments/:id/storage', async (req, res) => {
        // Delegated to TemporalBridge (manual resize)
        try {
            const info = await temporalBridge.resizeDisk(req.params.id, req.body.storage);
            res.status(202).json({
                message: 'Resize started',
                deploymentId: req.params.id,
                workflowId: info.id,
                state: 'running',
            });
        }
        catch (err) {
            res.status(503).json({ error: `Temporal resize disk unavailable: ${err.message}` });
        }
    });
    /** ── REGISTRY ── */
    app.get('/api/registry/search', async (req, res) => res.json(await registryService.search(req.query.q)));
    app.get('/api/registry/tags', async (req, res) => res.json(await registryService.getTags(req.query.repo)));
    /** ── NGINX config ── */
    const NGINX_CONF_PATH = path_1.default.join(__dirname, 'data/nginx/nginx.conf');
    app.get('/api/nginx/config', async (req, res) => {
        try {
            res.json({ content: await promises_1.default.readFile(NGINX_CONF_PATH, 'utf-8') });
        }
        catch (err) {
            res.status(500).json({ error: `Failed to read nginx config: ${err.message}` });
        }
    });
    app.post('/api/nginx/config', async (req, res) => {
        try {
            const { content } = req.body;
            if (typeof content !== 'string')
                return res.status(400).json({ error: 'Config content must be a string' });
            await promises_1.default.writeFile(NGINX_CONF_PATH, content);
            const execAsync = (await import('util')).promisify((await import('child_process')).exec);
            await execAsync('docker exec provisioner-nginx nginx -s reload');
            res.json({ message: 'Nginx config updated and reloaded successfully' });
        }
        catch (err) {
            res.status(500).json({ error: `Failed to update nginx config: ${err.message}` });
        }
    });
    /** ── LOGS ── */
    app.get('/api/logs/:type/:id', async (req, res) => {
        const { type, id } = req.params;
        const resource = type === 'cluster'
            ? await clusterService.getById(id)
            : (await appService.getAll()).find((d) => d.id === id);
        if (!resource || !resource.lastLogPath)
            return res.json({ content: 'Initializing...' });
        try {
            res.json({ content: await promises_1.default.readFile(resource.lastLogPath, 'utf-8') });
        }
        catch {
            res.json({ content: 'Waiting for logs...' });
        }
    });
    /** ── INIT ── */
    appExposureService.syncExposedApps().catch((e) => {
        const err = e instanceof Error ? e.message : String(e);
        console.error(`Failed to sync exposed apps to nginx: ${err}`);
    });
    const hostTunnelPort = process.env.IS_E2E === 'true' || process.env.NODE_ENV === 'test' ? 8001 : 8000;
    startHostTunnel(hostTunnelPort);
    httpServer.listen(port, () => console.log(`🚀 Provisioning Server Active on http://localhost:${port}`));
    return { app, io, temporalBridge };
}
bootstrap().catch(console.error);
//# sourceMappingURL=index.js.map