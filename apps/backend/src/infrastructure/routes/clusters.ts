import { Router, type Request } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { asyncRoute, decryptValue, type SecretKey, type ClusterOwnership } from '../../platform/index.js';
import { validateClusterName } from '../lib/cluster-name.js';
import { generateSshKeypair } from '../lib/ssh-keypair.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { AppService } from '../services/AppService.js';
import type { ClusterProxyService } from '../services/ClusterProxyService.js';
import type { GiteaService } from '../../projects/services/GiteaService.js';
import type { InfisicalService } from '../services/InfisicalService.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { InfrastructureStore } from '../store.js';

export interface ClustersRouterDeps {
  clusterService: ClusterService;
  appService: Pick<AppService, 'discoverDeployments'>;
  clusterProxyService: Pick<ClusterProxyService, 'ensurePortForward' | 'stopForCluster' | 'getAutoLoginCookies'>;
  giteaService: GiteaService;
  infisicalService: InfisicalService;
  infraService: Pick<InfrastructureService, 'runKubectl'>;
  temporalBridge: TemporalBridge;
  db: Pick<InfrastructureStore, 'getClusters' | 'saveClusterList'>;
  io: SocketServer;
  dataKey: SecretKey;
  ownsCluster: ClusterOwnership;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function clustersRouter(deps: ClustersRouterDeps): Router {
  const {
    clusterService, appService, clusterProxyService, infraService,
    temporalBridge, db, io, giteaService, infisicalService,
  } = deps;
  const DATA_KEY = deps.dataKey;
  const router = Router();

  const PROXY_SERVICES = ['prometheus', 'grafana', 'traefik', 'gitea', 'alertmanager', 'infisical'] as const;

  async function getGrafanaAdminCredentials(kubeconfigPath: string): Promise<{ username: string; password: string }> {
    const raw = await infraService.runKubectl(
      ['get', 'secret', 'kube-prometheus-stack-grafana', '-n', 'monitoring', '-o', 'jsonpath={.data.admin-password}'],
      kubeconfigPath,
    );
    return { username: 'admin', password: Buffer.from(raw.trim(), 'base64').toString('utf8') };
  }

  async function ownedCluster(req: Request) {
    const viewer = userOf(req);
    const cluster = await clusterService.getById(idOf(req), viewer.id);
    return cluster && deps.ownsCluster(viewer, cluster) ? cluster : undefined;
  }

  for (const serviceKey of PROXY_SERVICES) {
    router.get(`/:id/proxy/${serviceKey}`, async (req, res) => {
      try {
        const clusterId = idOf(req);
        const cluster = await ownedCluster(req);
        if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

        const kubeconfigPath = await clusterService.getKubeconfigPath(cluster);
        const targetUrl = await clusterProxyService.ensurePortForward(clusterId, serviceKey, kubeconfigPath);

        if (serviceKey === 'gitea' || serviceKey === 'grafana' || serviceKey === 'infisical') {
          try {
            const credentials = serviceKey === 'gitea'
              ? await giteaService.getAdminCredentials()
              : serviceKey === 'grafana'
                ? await getGrafanaAdminCredentials(kubeconfigPath)
                : await infisicalService.getAdminCredentials();
            const cookies = await clusterProxyService.getAutoLoginCookies(serviceKey, targetUrl, credentials);
            for (const cookie of cookies) res.append('Set-Cookie', cookie);
          } catch (err: any) {
            console.warn(`[proxy] Auto-login failed for ${serviceKey}: ${err.message} — falling back to manual login`);
          }
          return res.redirect(302, targetUrl);
        }

        res.setHeader('Content-Type', 'text/html');
        res.send(`<!DOCTYPE html><html><head><title>${serviceKey}</title></head><body style="margin:0"><iframe src="${targetUrl}" style="width:100%;height:100vh;border:none"></iframe></body></html>`);
      } catch (err: any) {
        res.status(502).json({ error: `Service unavailable: ${err.message}` });
      }
    });
  }

  router.get('/', asyncRoute(async (req, res) => res.json(await clusterService.getAll(userOf(req).id, io))));

  router.post('/', async (req, res) => {
    try {
      const nameCheck = validateClusterName(req.body.name);
      if (!nameCheck.ok) {
        return res.status(400).json({
          error: nameCheck.error,
          ...(nameCheck.suggestion ? { suggestion: nameCheck.suggestion } : {}),
        });
      }

      const remote = req.body.provider === 'remote'
        ? {
            host: req.body.remoteHost,
            username: req.body.remoteUsername,
            privateKey: req.body.remoteSshPrivateKey,
            ...(typeof req.body.remoteSshPort === 'number' ? { port: req.body.remoteSshPort } : {}),
            ...(typeof req.body.remoteK3sApiPort === 'number' ? { k3sApiPort: req.body.remoteK3sApiPort } : {}),
          }
        : undefined;
      if (remote && (!remote.host || !remote.username)) {
        return res.status(400).json({ error: 'remoteHost and remoteUsername are required for provider "remote"' });
      }

      if (remote && !remote.privateKey) {
        const pair = await generateSshKeypair(`nowrinkles-${req.body.name}`);
        const saved = await clusterService.createAwaitingKey({
          name: req.body.name,
          ownerId: userOf(req).id,
          host: remote.host,
          username: remote.username,
          privateKey: pair.privateKey,
          ...(remote.port !== undefined ? { port: remote.port } : {}),
        });
        return res.status(201).json({
          id: saved.id,
          status: 'awaiting-key',
          publicKey: pair.publicKey.trim(),
          message: 'Authorise this key on the machine, then start provisioning.',
        });
      }
      const hetzner = req.body.provider === 'hetzner'
        ? {
            ...(req.body.hetznerServerType ? { serverType: String(req.body.hetznerServerType) } : {}),
            ...(req.body.hetznerLocation ? { location: String(req.body.hetznerLocation) } : {}),
            ...(req.body.hetznerImage ? { image: String(req.body.hetznerImage) } : {}),
          }
        : undefined;
      const info = await temporalBridge.provision(req.body.name, req.body.provider, userOf(req).id, remote, hetzner);
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

  router.post('/:id/start', async (req, res) => {
    try {
      const userId = userOf(req).id;
      const cluster = await clusterService.getById(idOf(req), userId);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
      if (cluster.status !== 'awaiting-key') {
        return res.status(409).json({ error: `Cluster "${cluster.name}" is ${cluster.status}, not awaiting a key.` });
      }
      if (!cluster.remoteHost || !cluster.remoteUsername || !cluster.remoteSshPrivateKeyEnc) {
        return res.status(400).json({ error: 'Cluster is missing its connection details.' });
      }

      const info = await temporalBridge.provision(cluster.name, 'remote', userId, {
        host: cluster.remoteHost,
        username: cluster.remoteUsername,
        privateKey: decryptValue(cluster.remoteSshPrivateKeyEnc, DATA_KEY),
        ...(cluster.remoteSshPort !== undefined ? { port: cluster.remoteSshPort } : {}),
      });

      const all = await db.getClusters();
      await db.saveClusterList(all.filter((c) => c.id !== cluster.id));

      res.status(202).json({ message: 'Provisioning started', id: info.resourceId, workflowId: info.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    if (idOf(req) === 'provisioning-lunorica') {
      return res.status(403).json({ error: 'The system management cluster cannot be destroyed' });
    }
    try {
      const cluster = await clusterService.getById(idOf(req), userOf(req).id);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
      clusterProxyService.stopForCluster(idOf(req));
      if (cluster.status === 'provisioning') {
        await clusterService.abort(idOf(req), userOf(req).id, io);
        return res.json({ success: true, message: 'Cluster provisioning aborted' });
      }
      const info = await temporalBridge.destroyCluster(idOf(req));
      res.status(202).json({
        message: 'Destroying cluster',
        clusterId: idOf(req),
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      try {
        await clusterService.abort(idOf(req), userOf(req).id, io);
        res.json({ success: true, message: 'Cluster deleted' });
      } catch (fallbackErr: any) {
        res.status(503).json({ error: `Cluster destruction unavailable: ${err.message}` });
      }
    }
  });

  router.post('/discover', async (req, res) => {
    try {
      const discovered = await clusterService.discoverClusters(userOf(req).id);
      res.json({ clusters: discovered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/discover-deployments', async (req, res) => {
    try {
      const discovered = await appService.discoverDeployments(idOf(req), userOf(req).id);
      res.json({ deployments: discovered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:id/gpu-status', asyncRoute(async (req, res) => {
    if (!(await ownedCluster(req))) return res.status(404).json({ error: 'Cluster not found' });
    return res.json(await clusterService.getGpuStatus(idOf(req), userOf(req).id));
  }));

  return router;
}
