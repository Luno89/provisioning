import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { Server as SocketServer } from 'socket.io';

// Library Imports
import { LocalDB } from './lib/db.js';

// Service Imports
import { InfrastructureService } from './services/InfrastructureService.js';
import { ClusterService } from './services/ClusterService.js';
import { AppService } from './services/AppService.js';
import { RegistryService } from './services/RegistryService.js';
import { GitModuleService } from './services/GitModuleService.js';
import { BuilderService } from './services/BuilderService.js';
import { AppExposureService } from './services/AppExposureService.js';
import type { ClusterMetadata, DeploymentMetadata } from './lib/types.js';
import { TemporalBridge } from './services/TemporalBridge.js';
import WorkerService from './services/WorkerService.js';
import net from 'net';
import { spawn } from 'child_process';

dotenv.config();

function startHostTunnel(port = 8000) {
  const server = net.createServer((socket) => {
    const child = spawn('docker', ['exec', '-i', 'provisioner-nginx', 'nc', '127.0.0.1', '80']);

    socket.pipe(child.stdin);
    child.stdout.pipe(socket);

    socket.on('error', () => child.kill());
    child.on('error', () => socket.destroy());
    socket.on('close', () => child.kill());
    child.on('close', () => socket.destroy());
  });

  server.on('error', (err: any) => {
    console.error(`Host tunnel server error: ${err.message}`);
  });

  server.listen(port, '::', () => {
    console.log(`🚀 Host Tunnel Server active on http://[::]:${port}`);
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
export async function bootstrap(): Promise<{ app: express.Application; io: SocketServer; temporalBridge?: TemporalBridge }> {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, { cors: { origin: '*' } });
  const port = process.env.PORT || 3001;

  // ── 1. Initialize backend ────────────────────────────────────────────────
  const db = new LocalDB();
  await db.init();

  const infraService = new InfrastructureService();
  const builderService = new BuilderService(db, infraService);
  const clusterService = new ClusterService(db, infraService);
  const appService = new AppService(db, infraService, clusterService, builderService);
  const registryService = new RegistryService(db);
  const gitModuleService = new GitModuleService(db);
  const appExposureService = new AppExposureService(db, infraService, clusterService, io);

  // ── 2. Temporal bridge (HTTP only → sketch → poll DB) ────────────────────
  const temporalBridge = new TemporalBridge(db, io);
  try {
    await temporalBridge.start();
    await temporalBridge.startActiveWorkflowRecovery();
  } catch (e: any) {
    // If Temporal is not reachable, serve the same UI with normal polling
    console.warn(`⚠️ Temporal TS bridge not available. Routes will fall back to Local DB.`, e.message);
  }

  app.use(cors());
  app.use(express.json());

  // ── 3. SOCKET.IO ORCHESTRATION ───────────────────────────────────────────
  io.on('connection', (socket) => {
    const socketTails = new Map<string, any>();

    socket.on('join-room', async (id) => {
      socket.join(id);

      const existing = socketTails.get(id);
      if (existing) {
        existing.kill();
        socketTails.delete(id);
      }

      const resource = (await clusterService.getById(id)) || 
                       (await appService.getAll()).find((d: any) => d.id === id);

      if (resource && resource.lastLogPath) {
        try {
          await fs.access(resource.lastLogPath);
        } catch {
          await fs.mkdir(path.dirname(resource.lastLogPath), { recursive: true }).catch(() => {});
          await fs.writeFile(resource.lastLogPath, '').catch(() => {});
        }

        const tail = spawn('tail', ['-n', '0', '-f', resource.lastLogPath]);
        socketTails.set(id, tail);

        tail.stdout.on('data', (data) => {
          socket.emit('log', data.toString());
        });

        tail.stderr.on('data', (data) => {
          socket.emit('log', data.toString());
        });

        tail.on('close', () => {
          socketTails.delete(id);
        });
      }
    });

    socket.on('join-kube-room', (id) => socket.join(`${id}-kube`));
    socket.on('tail-pod', async ({ resourceId, podName, namespace }) => {
      const deployments = await appService.getAll();
      const dep = deployments.find(d => d.id === resourceId);
      let context: string | undefined;
      let kubeconfigPath: string | undefined;
      if (dep) {
        const cluster = await clusterService.getById(dep.clusterId);
        if (cluster) {
          if (cluster.provider === 'k3d') context = `k3d-${cluster.name}`;
          kubeconfigPath = await clusterService.getKubeconfigPath(cluster);
        }
      }
      const args = ['logs', '-n', namespace || 'default', podName, '--tail=100', '-f'];
      if (context) args.push('--context', context);
      infraService.streamLogs(resourceId, args, io, `${resourceId}-kube`, kubeconfigPath);
    });

    socket.on('leave-room', (id) => {
      socket.leave(id);
      const tail = socketTails.get(id);
      if (tail) {
        tail.kill();
        socketTails.delete(id);
      }
    });

    socket.on('leave-kube-room', (id) => { socket.leave(`${id}-kube`); infraService.stopStream(id); });

    socket.on('disconnect', () => {
      for (const tail of socketTails.values()) {
        tail.kill();
      }
      socketTails.clear();
    });
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
        id: info.resourceId,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
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
    } catch (err: any) {
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
      res.status(202).json({
        message: 'Deployment started',
        deploymentName: req.body.name,
        id: info.resourceId,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
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
    } catch (err: any) {
      res.status(503).json({ error: `Temporal app destroy unavailable: ${err.message}` });
    }
  });

  app.get('/api/deployments/:id/helm', async (req, res) => res.json({ content: await appService.getHelmStatus(req.params.id) }));
  app.get('/api/deployments/:id/diagnostics', async (req, res) => res.json({ content: await appService.getDiagnostics(req.params.id) }));
  app.get('/api/deployments/:id/pods', async (req, res) => {
    try { res.json(await appService.listPods(req.params.id)); } catch { res.status(500).json({ error: 'Failed to list pods' }); }
  });

  app.post('/api/deployments/:id/expose', async (req, res) => {
    try { res.json(await appExposureService.expose(req.params.id)); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/deployments/:id/unexpose', async (req, res) => {
    try { res.json(await appExposureService.unexpose(req.params.id)); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.patch('/api/deployments/:id/exposure-path', async (req, res) => {
    try {
      const { path } = req.body;
      res.json(await appExposureService.updateExposurePath(req.params.id, path));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** ── MODULES ── */
  app.get('/api/modules', async (req, res) => res.json(await gitModuleService.listAvailableModules(req.query.appType as string)));

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
    } catch (err: any) {
      res.status(503).json({ error: `Temporal resize disk unavailable: ${err.message}` });
    }
  });

  /** ── REGISTRY ── */
  app.get('/api/registry/search', async (req, res) => res.json(await registryService.search(req.query.q as string)));
  app.get('/api/registry/tags', async (req, res) => res.json(await registryService.getTags(req.query.repo as string)));

  /** ── NGINX config ── */
  const NGINX_CONF_PATH = path.join(__dirname, '../data/nginx/nginx.conf');

  app.get('/api/nginx/config', async (req, res) => {
    try { res.json({ content: await fs.readFile(NGINX_CONF_PATH, 'utf-8') }); }
    catch (err: any) { res.status(500).json({ error: `Failed to read nginx config: ${err.message}` }); }
  });

  app.post('/api/nginx/config', async (req, res) => {
    try {
      const { content } = req.body;
      if (typeof content !== 'string') return res.status(400).json({ error: 'Config content must be a string' });
      await fs.writeFile(NGINX_CONF_PATH, content);

      const execAsync = (await import('util')).promisify((await import('child_process')).exec);
      await execAsync('docker exec provisioner-nginx nginx -s reload');
      res.json({ message: 'Nginx config updated and reloaded successfully' });
    } catch (err: any) { res.status(500).json({ error: `Failed to update nginx config: ${err.message}` }); }
  });

  /** ── LOGS ── */
  app.get('/api/logs/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const resource = type === 'cluster'
      ? await clusterService.getById(id)
      : (await appService.getAll()).find((d: any) => d.id === id);
    if (!resource || !resource.lastLogPath) return res.json({ content: 'Initializing...' });
    try {
      const content = await fs.readFile(resource.lastLogPath, 'utf-8');
      res.json({ content });
    }
    catch {
      res.json({ content: 'Waiting for logs...' });
    }
  });

  /** ── TEMPORAL — monitoring ── */

  app.get('/api/temporal/status', async (req, res) => {
    const ready = temporalBridge.isReady();
    let version: string | undefined;
    if (ready) {
      try {
        const svc = (temporalBridge as any).client.workflowService;
        const info = await svc?.getSystemInfo?.();
        version = info?.serverVersion;
      } catch {}
    }
    res.json({ connected: ready, serverVersion: version });
  });

  app.get('/api/temporal/workflows', async (req, res) => {
    const query = req.query.query as string | undefined;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 50;
    const workflows = await temporalBridge.listWorkflows(query, pageSize);
    res.json({ workflows });
  });

  app.get('/api/temporal/workflows/count', async (req, res) => {
    const [total, running, completed, failed, timedOut] = await Promise.all([
      temporalBridge.countWorkflows(''),
      temporalBridge.countWorkflows('ExecutionStatus="Running"'),
      temporalBridge.countWorkflows('ExecutionStatus="Completed"'),
      temporalBridge.countWorkflows('ExecutionStatus="Failed"'),
      temporalBridge.countWorkflows('ExecutionStatus="TimedOut"'),
    ]);
    res.json({ total, running, completed, failed, timedOut });
  });

  app.get('/api/temporal/workflows/:workflowId', async (req, res) => {
    const workflow = await temporalBridge.describeWorkflow(req.params.workflowId);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ workflow });
  });

  app.get('/api/temporal/workflows/:workflowId/history', async (req, res) => {
    const events = await temporalBridge.getWorkflowHistory(req.params.workflowId);
    if (!events) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ events });
  });

  /** ── INIT ── */
  appExposureService.syncExposedApps().catch((e) => {
    const err = e instanceof Error ? e.message : String(e);
    console.error(`Failed to sync exposed apps to nginx: ${err}`);
  });

  // ── WORKER ──

  const workerService = new WorkerService();

  app.post('/api/worker', async (req, res) => {
    try {
      const { clusterId, context } = req.body || {};
      if (!clusterId) return res.status(400).json({ error: 'clusterId is required' });
      console.log(`[Worker] Initialized worker ${clusterId} (context: ${context || 'local'})`);
      res.status(202).json({
        message: 'Worker initialized',
        clusterId,
        context: context || 'local',
        state: 'running',
      });
    } catch (err: any) {
      console.error(`[Worker] Failed to initialize: ${err.message}`);
      res.status(503).json({ error: err.message });
    }
  });

  app.delete('/api/worker', async (req, res) => {
    try {
      console.log('[Worker] Worker stopped');
      res.status(200).json({ message: 'Worker stopped' });
    } catch (err: any) {
      console.error(`[Worker] Failed to stop: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/worker', async (req, res) => {
    try {
      const state = workerService.status();
      res.json({
        clusterId: state?.clusterId || '',
        context: state?.context || 'local',
        state: state?.state || 'stopped',
        running: state?.state === 'running',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const hostTunnelPort = process.env.IS_E2E === 'true' || process.env.NODE_ENV === 'test' ? 8001 : 8000;
  startHostTunnel(hostTunnelPort);

  httpServer.listen(port, () => console.log(`🚀 Provisioning Server Active on http://localhost:${port}`));

  return { app, io, temporalBridge };
}

bootstrap().catch(console.error);
