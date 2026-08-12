/**
 * Building the agent's web tools outside the API process.
 *
 * ── WHY THIS EXISTS ──
 * `resolveWebTools` needs a database, a kubeconfig and a port-forward, and until now the only place
 * that had all three was the closure inside `bootstrap()`. So the CHAT agent reached the SearXNG and
 * Crawl4AI this platform deploys, and the EXECUTION agent — the one doing the actual research —
 * could not, because it runs in a worker.
 *
 * What it did instead was scrape DuckDuckGo's HTML from a copy of the logic inlined in the agent
 * loop. Two search implementations, and the leaves used the worse one: no Crawl4AI extraction, no
 * control over the engine list, and nothing pointing at the services the user provisioned on
 * purpose. The Lab had it worse still — it passed no web tools at all, so its research tasks tried
 * `curl` against a default-deny sandbox and reported, correctly, that they had no internet access.
 *
 * Constructed per call, like the API's own version, because the deployment can appear, move or go
 * away while the worker is up. The port-forward underneath is cached, so the repeat cost is a
 * database read.
 */
import type { Database } from './db-interface.js';
import { resolveWebTools } from './web-tools-resolver.js';
import type { WebTools } from './web-tools.js';
import { ClusterProxyService } from '../services/ClusterProxyService.js';
import { ClusterService } from '../services/ClusterService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';

export async function buildWebTools(db: Database, ownerId?: string): Promise<WebTools> {
  const infra = new InfrastructureService();
  const clusters = new ClusterService(db, infra);
  const proxy = new ClusterProxyService();

  return resolveWebTools(
    {
      db,
      ensurePortForward: (clusterId, serviceKey, kubeconfigPath, target) =>
        proxy.ensurePortForward(clusterId, serviceKey, kubeconfigPath, target),
      kubeconfigFor: async (clusterId: string) => {
        // getByIdUnscoped, NOT db.getClusters(): the management cluster is SYNTHESIZED by
        // ClusterService and never written to the database, and it is the cluster almost everything
        // is deployed to. Same reasoning as the API's copy of this.
        const cluster = await clusters.getByIdUnscoped(clusterId);
        return cluster ? clusters.getKubeconfigPath(cluster) : undefined;
      },
    },
    ownerId,
  );
}
