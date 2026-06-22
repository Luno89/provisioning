import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { createServer } from 'http';
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

dotenv.config();

/**
 * APPLICATION BOOTSTRAP
 * We use a Service-Oriented Architecture to manage the complexity of
 * infrastructure provisioning and application deployments.
 */
async function bootstrap() {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, { cors: { origin: '*' } });
  const port = process.env.PORT || 3001;

  // 1. Initialize Database (Repository)
  const db = new LocalDB();
  await db.init();

  // 2. Initialize Services (Business Logic)
  const infraService = new InfrastructureService();
  const builderService = new BuilderService(db, infraService);
  const clusterService = new ClusterService(db, infraService);
  const appService = new AppService(db, infraService, clusterService, builderService);
  const registryService = new RegistryService(db);
  const gitModuleService = new GitModuleService(db);

  app.use(cors());
  app.use(express.json());

  // SOCKET.IO ORCHESTRATION
  io.on('connection', (socket) => {
    socket.on('join-room', (id) => socket.join(id));
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

    socket.on('leave-room', (id) => socket.leave(id));
    socket.on('leave-kube-room', (id) => { 
      socket.leave(`${id}-kube`); 
      infraService.stopStream(id); 
    });
  });

  // CLUSTER ROUTES
  app.get('/api/clusters', async (req, res) => res.json(await clusterService.getAll()));
  app.post('/api/clusters', async (req, res) => res.status(202).json(await clusterService.provision(req.body.name, req.body.provider, io)));
  app.delete('/api/clusters/:id', async (req, res) => {
    await clusterService.delete(req.params.id, io);
    res.status(202).json({ message: 'Deletion triggered' });
  });
  app.get('/api/clusters/:id/all-pods', async (req, res) => res.json(await clusterService.listAllPods(req.params.id)));
  app.get('/api/clusters/:id/helm-releases', async (req, res) => res.json(await clusterService.listReleases(req.params.id)));

  // APPLICATION ROUTES
  app.get('/api/deployments', async (req, res) => res.json(await appService.getAll()));
  app.post('/api/deployments', async (req, res) => res.status(202).json(await appService.deploy(req.body, io)));
  app.delete('/api/deployments/:id', async (req, res) => {
    await appService.delete(req.params.id, io);
    res.status(202).json({ message: 'Deletion triggered' });
  });
  app.get('/api/deployments/:id/helm', async (req, res) => res.json({ content: await appService.getHelmStatus(req.params.id) }));
  app.get('/api/deployments/:id/diagnostics', async (req, res) => res.json({ content: await appService.getDiagnostics(req.params.id) }));
  app.get('/api/deployments/:id/pods', async (req, res) => {
    try {
      const result = await appService.listPods(req.params.id);
      res.json(result);
    } catch {
      res.status(500).json({ error: 'Failed to list pods' });
    }
  });

  // MODULE ROUTES
  app.get('/api/modules', async (req, res) => res.json(await gitModuleService.listAvailableModules()));
  app.patch('/api/deployments/:id/modules', async (req, res) => {
    const { modules } = req.body;
    res.status(202).json(await appService.updateModules(req.params.id, modules, io));
  });

  // REGISTRY ROUTES
  app.get('/api/registry/search', async (req, res) => res.json(await registryService.search(req.query.q as string)));
  app.get('/api/registry/tags', async (req, res) => res.json(await registryService.getTags(req.query.repo as string)));

  // LOGS LOGIC
  app.get('/api/logs/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const resource = type === 'cluster' ? await clusterService.getById(id) : (await appService.getAll()).find((d:any) => d.id === id);
    if (!resource || !resource.lastLogPath) return res.json({ content: 'Initializing...' });
    try { res.json({ content: await fs.readFile(resource.lastLogPath, 'utf-8') }); } 
    catch { res.json({ content: 'Waiting for logs...' }); }
  });

  httpServer.listen(port, () => console.log(`🚀 Provisioning Server Active on http://localhost:${port}`));
}

bootstrap().catch(console.error);
