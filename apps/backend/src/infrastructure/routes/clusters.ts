import { Router, type Request } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { asyncRoute, authorize, clusterResource, principalFrom, type ClusterMetadata } from '../../platform/index.js';
import { signsInAsPlatform, validateClusterName } from '../lib/cluster-name.js';
import { isClusterProviderName, notAClusterProvider, ProvisionRefused } from '../lib/cluster-topology.js';
import { provisionRequestOf } from '../lib/cluster-request.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { ClusterProxyService } from '../services/ClusterProxyService.js';
import type { GiteaService } from '../../projects/index.js';
import type { InfisicalService } from '../services/InfisicalService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { ClusterAccess } from '../services/ClusterAccess.js';

export interface ProvisionStarted {
  message: 'Provisioning started';
  clusterName: string;
  provider: ClusterMetadata['provider'];
  id: string;
  workflowId: string;
  state: 'running';
}

export interface ClustersRouterDeps {
  clusterService: ClusterService;
  clusterProxyService: Pick<ClusterProxyService, 'ensurePortForward' | 'stopForCluster' | 'getAutoLoginCookies'>;
  giteaService: GiteaService;
  infisicalService: InfisicalService;
  access: Pick<ClusterAccess, 'kubectl'>;
  temporalBridge: TemporalBridge;
  io: SocketServer;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

export function clustersRouter(deps: ClustersRouterDeps): Router {
  const {
    clusterService, clusterProxyService, access,
    temporalBridge, io, giteaService, infisicalService,
  } = deps;
  const router = Router();

  const PROXY_SERVICES = ['prometheus', 'grafana', 'traefik', 'gitea', 'alertmanager', 'infisical'] as const;

  async function getGrafanaAdminCredentials(clusterId: string): Promise<{ username: string; password: string }> {
    const raw = await access.kubectl(
      clusterId,
      ['get', 'secret', 'kube-prometheus-stack-grafana', '-n', 'monitoring', '-o', 'jsonpath={.data.admin-password}'],
    );
    return { username: 'admin', password: Buffer.from(raw.trim(), 'base64').toString('utf8') };
  }

  const ownedCluster = (req: Request) => clusterService.getById(idOf(req), principalFrom(req), 'see-everything');

  for (const serviceKey of PROXY_SERVICES) {
    router.get(`/:id/proxy/${serviceKey}`, asyncRoute(async (req, res) => {
      try {
        const cluster = await ownedCluster(req);
        if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

        const targetUrl = await clusterProxyService.ensurePortForward(cluster.id, serviceKey);

        if (serviceKey === 'gitea' || serviceKey === 'grafana' || serviceKey === 'infisical') {
          if (signsInAsPlatform(serviceKey, clusterService.isKoalasCluster(cluster.id))) {
            try {
              const credentials = serviceKey === 'gitea'
                ? await giteaService.getAdminCredentials()
                : serviceKey === 'grafana'
                  ? await getGrafanaAdminCredentials(cluster.id)
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
    }));
  }

  router.get('/', asyncRoute(async (req, res) => res.json(await clusterService.getAll(principalFrom(req), io))));

  router.post('/', asyncRoute(async (req, res) => {
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

      if (!isClusterProviderName(body.provider)) return res.status(400).json({ error: notAClusterProvider(body.provider) });
      const info = await temporalBridge.provision(name, body.provider, userOf(req).id, body.vm);
      const started: ProvisionStarted = {
        message: 'Provisioning started',
        clusterName: name,
        provider: body.provider,
        id: info.resourceId,
        workflowId: info.id,
        state: 'running',
      };
      res.status(202).json(started);
    } catch (err) {
      if (err instanceof ProvisionRefused) return res.status(400).json({ error: err.message });
      res.status(503).json({ error: `Temporal cluster provisioning unavailable: ${(err as Error).message}` });
    }
  }));


  router.delete('/:id', asyncRoute(async (req, res) => {
    const cluster = await clusterService.getById(idOf(req), principalFrom(req));
    if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
    const decision = authorize(principalFrom(req), 'delete', clusterResource(cluster));
    if (!decision.allowed) return res.status(decision.status).json({ error: decision.error });
    if (clusterService.isKoalasCluster(cluster.id)) return res.status(409).json({ error: 'This is the cluster this Koala runs in; it goes only with its machine, removed under My Machines' });
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
  }));

  router.get('/:id/gpu-status', asyncRoute(async (req, res) => {
    if (!(await ownedCluster(req))) return res.status(404).json({ error: 'Cluster not found' });
    return res.json(await clusterService.getGpuStatus(idOf(req), principalFrom(req)));
  }));

  return router;
}
