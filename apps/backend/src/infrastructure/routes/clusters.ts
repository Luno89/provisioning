import { Router, type Request } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { asyncRoute, authorize, clusterResource, decryptValue, principalFrom, type SecretKey } from '../../platform/index.js';
import { signsInAsPlatform, validateClusterName } from '../lib/cluster-name.js';
import { generateSshKeypair } from '../lib/ssh-keypair.js';
import { isClusterProviderName, notAClusterProvider, ProvisionRefused } from '../lib/cluster-topology.js';
import { provisionRequestOf } from '../lib/cluster-request.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { AppService } from '../services/AppService.js';
import type { ClusterProxyService } from '../services/ClusterProxyService.js';
import type { GiteaService } from '../../projects/index.js';
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
  db: Pick<InfrastructureStore, 'getClusters' | 'deleteCluster'>;
  io: SocketServer;
  dataKey: SecretKey;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

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

  const ownedCluster = (req: Request) => clusterService.getById(idOf(req), principalFrom(req), 'see-everything');

  for (const serviceKey of PROXY_SERVICES) {
    router.get(`/:id/proxy/${serviceKey}`, async (req, res) => {
      try {
        const clusterId = idOf(req);
        const cluster = await ownedCluster(req);
        if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

        const kubeconfigPath = await clusterService.getKubeconfigPath(cluster);
        const targetUrl = await clusterProxyService.ensurePortForward(clusterId, serviceKey, kubeconfigPath);

        if (serviceKey === 'gitea' || serviceKey === 'grafana' || serviceKey === 'infisical') {
          if (signsInAsPlatform(serviceKey, cluster.id)) {
            try {
              const credentials = serviceKey === 'gitea'
                ? await giteaService.getAdminCredentials()
                : serviceKey === 'grafana'
                  ? await getGrafanaAdminCredentials(kubeconfigPath)
                  : await infisicalService.getAdminCredentials();
              const cookies = await clusterProxyService.getAutoLoginCookies(serviceKey, targetUrl, credentials);
              for (const cookie of cookies) res.append('Set-Cookie', cookie);
            } catch (err) {
              console.warn(`[proxy] Auto-login failed for ${serviceKey}: ${(err as Error).message} — falling back to manual login`);
            }
          }
          return res.redirect(302, targetUrl);
        }

        res.setHeader('Content-Type', 'text/html');
        res.send(`<!DOCTYPE html><html><head><title>${serviceKey}</title></head><body style="margin:0"><iframe src="${targetUrl}" style="width:100%;height:100vh;border:none"></iframe></body></html>`);
      } catch (err) {
        res.status(502).json({ error: `Service unavailable: ${(err as Error).message}` });
      }
    });
  }

  router.get('/', asyncRoute(async (req, res) => res.json(await clusterService.getAll(principalFrom(req), io))));

  router.post('/', async (req, res) => {
    try {
      const body = provisionRequestOf(req.body);
      const nameCheck = validateClusterName(body.name);
      if (!nameCheck.ok) {
        return res.status(400).json({
          error: nameCheck.error,
          ...(nameCheck.suggestion ? { suggestion: nameCheck.suggestion } : {}),
        });
      }
      const name = String(body.name);

      const remote = body.remote;
      if (remote && (!remote.host || !remote.username)) {
        return res.status(400).json({ error: 'remoteHost and remoteUsername are required for provider "remote"' });
      }

      if (remote && !remote.privateKey) {
        const pair = await generateSshKeypair(`nowrinkles-${name}`);
        const saved = await clusterService.createAwaitingKey({
          name,
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
      if (!isClusterProviderName(body.provider)) return res.status(400).json({ error: notAClusterProvider(body.provider) });
      const info = await temporalBridge.provision(name, body.provider, userOf(req).id, remote, body.vm);
      res.status(202).json({
        message: 'Provisioning started',
        clusterName: name,
        provider: body.provider,
        id: info.resourceId,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err) {
      if (err instanceof ProvisionRefused) return res.status(400).json({ error: err.message });
      res.status(503).json({ error: `Temporal cluster provisioning unavailable: ${(err as Error).message}` });
    }
  });

  router.post('/:id/start', async (req, res) => {
    try {
      const userId = userOf(req).id;
      const cluster = await clusterService.getById(idOf(req), principalFrom(req), 'change');
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

      await db.deleteCluster(cluster.id);

      res.status(202).json({ message: 'Provisioning started', id: info.resourceId, workflowId: info.id });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/:id', async (req, res) => {
    const cluster = await clusterService.getById(idOf(req), principalFrom(req));
    if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
    const decision = authorize(principalFrom(req), 'delete', clusterResource(cluster));
    if (!decision.allowed) return res.status(decision.status).json({ error: decision.error });
    try {
      clusterProxyService.stopForCluster(idOf(req));
      if (cluster.status === 'provisioning') {
        await clusterService.abort(idOf(req), principalFrom(req), io);
        return res.json({ success: true, message: 'Cluster provisioning aborted' });
      }
      const info = await temporalBridge.destroyCluster(idOf(req));
      res.status(202).json({
        message: 'Destroying cluster',
        clusterId: idOf(req),
        workflowId: info.id,
        state: 'running',
      });
    } catch (err) {
      try {
        await clusterService.abort(idOf(req), principalFrom(req), io);
        res.json({ success: true, message: 'Cluster deleted' });
      } catch (fallbackErr) {
        res.status(503).json({ error: `Cluster destruction unavailable: ${(err as Error).message}; deleting its record failed too: ${(fallbackErr as Error).message}` });
      }
    }
  });

  router.post('/discover', async (req, res) => {
    const decision = authorize(principalFrom(req), 'administer', { kind: 'install' });
    if (!decision.allowed) return res.status(decision.status).json({ error: decision.error });
    try {
      const discovered = await clusterService.discoverClusters(userOf(req).id);
      res.json({ clusters: discovered });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/:id/discover-deployments', async (req, res) => {
    if (!(await ownedCluster(req))) return res.status(404).json({ error: 'Cluster not found' });
    try {
      const discovered = await appService.discoverDeployments(idOf(req), principalFrom(req));
      res.json({ deployments: discovered });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/:id/gpu-status', asyncRoute(async (req, res) => {
    if (!(await ownedCluster(req))) return res.status(404).json({ error: 'Cluster not found' });
    return res.json(await clusterService.getGpuStatus(idOf(req), principalFrom(req)));
  }));

  return router;
}
