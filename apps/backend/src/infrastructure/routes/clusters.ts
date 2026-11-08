import { Router, type Request } from 'express';
import { asyncRoute, principalFrom } from '../../platform/index.js';
import { signsInAsPlatform } from '../lib/cluster-name.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { ClusterProxyService } from '../services/ClusterProxyService.js';
import type { GiteaService } from '../../projects/index.js';
import type { InfisicalService } from '../services/InfisicalService.js';
import type { ClusterAccess } from '../services/ClusterAccess.js';

export interface ClustersRouterDeps {
  clusterService: ClusterService;
  clusterProxyService: Pick<ClusterProxyService, 'ensurePortForward' | 'getAutoLoginCookies'>;
  giteaService: GiteaService;
  infisicalService: InfisicalService;
  access: Pick<ClusterAccess, 'kubectl'>;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

export function clustersRouter(deps: ClustersRouterDeps): Router {
  const {
    clusterService, clusterProxyService, access,
    giteaService, infisicalService,
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

  router.get('/', asyncRoute(async (req, res) => res.json(await clusterService.getAll(principalFrom(req)))));

  router.get('/:id/gpu-status', asyncRoute(async (req, res) => {
    if (!(await ownedCluster(req))) return res.status(404).json({ error: 'Cluster not found' });
    return res.json(await clusterService.getGpuStatus(idOf(req), principalFrom(req)));
  }));

  return router;
}
