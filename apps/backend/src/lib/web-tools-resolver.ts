/**
 * Finding the agent's web services — the impure half of `web-tools.ts`.
 *
 * Kept apart from that module deliberately: the resolution logic there is worth testing against
 * every failure a live service can produce, and it stays trivially testable only by having no idea
 * where a URL came from. This file is the part that knows about the database, kubeconfigs and
 * port-forwards.
 *
 * ── WHY A PORT-FORWARD ──
 * The backend runs on the host; the services run in the cluster. `.svc.cluster.local` does not
 * resolve here, and a NodePort would mean discovering an allocated port that changes on every
 * redeploy — the TabbyAPI endpoint moved from 31195 to 30697 doing exactly that. The proxy service
 * already solves this for the in-cluster dashboards, caches one forward per service, and hands back
 * a `http://localhost:<port>` that stays valid.
 */
import type { Database } from './db-interface.js';
import type { DeploymentMetadata } from './types.js';
import type { ServiceTarget } from '../services/ClusterProxyService.js';
import { createWebTools, type WebTools } from './web-tools.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ClusterService } from '../services/ClusterService.js';
import { ClusterProxyService } from '../services/ClusterProxyService.js';

/** Namespace naming has to match what the constructs deploy into — `namespace: deploymentName`. */
const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export interface WebToolsDeps {
  db: Pick<Database, 'getDeployments'>;
  /** Returns a `http://localhost:<port>` base, or throws if the forward cannot be established. */
  ensurePortForward: (clusterId: string, serviceKey: string, kubeconfigPath: string, target: ServiceTarget) => Promise<string>;
  /** Undefined when the cluster is gone or has no usable kubeconfig. */
  kubeconfigFor: (clusterId: string) => Promise<string | undefined>;
  env?: NodeJS.ProcessEnv;
}

/** A deployment is only usable if it finished and is still meant to be up. */
export function liveDeployment(deployments: DeploymentMetadata[], appType: string, ownerId?: string): DeploymentMetadata | undefined {
  return deployments.find((d) =>
    d.appType === appType
    && d.status === 'running'
    && d.clusterId
    // Scoped to the caller when we know who they are: another tenant's search service is not this
    // tenant's to route queries through, and the queries themselves are the agent's own reasoning.
    && (!ownerId || !d.ownerId || d.ownerId === ownerId));
}

async function baseUrlFor(
  deps: WebToolsDeps,
  dep: DeploymentMetadata,
  service: string,
  remotePort: number,
): Promise<string | undefined> {
  try {
    const kubeconfig = await deps.kubeconfigFor(dep.clusterId!);
    if (!kubeconfig) {
      // Logged, not silent: this is a distinct failure from the forward itself failing, and an
      // unlogged `return undefined` here cost real time — it looks identical to the deployment
      // never having been found.
      console.warn(`[web-tools] ${service} deployment "${dep.name}" has no resolvable kubeconfig for cluster ${dep.clusterId}`);
      return undefined;
    }
    const ns = sanitize(dep.name);
    const url = await deps.ensurePortForward(dep.clusterId!, `${service}-${dep.id}`, kubeconfig, {
      service, namespace: ns, remotePort,
    });
    // ensurePortForward appends the target's dashboardPath, which defaults to "/". Both APIs here
    // build their own paths, so a trailing slash would produce `//search`.
    return url.replace(/\/$/, '');
  } catch (err) {
    // Never fatal: a service that cannot be reached demotes the agent to the built-in scrape,
    // which is the whole point of the chain. Logged because a silent demotion is precisely the
    // failure that made the built-ins worth replacing.
    console.warn(`[web-tools] could not reach ${service} deployment "${dep.name}": ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Resolves the agent's web tools: deployed service → environment variable → the built-in scrape.
 *
 * The env vars come SECOND on purpose, unlike `credential-resolver.ts` where they come first. A
 * deployment is something the user made through this platform and can see in the UI; an env var is
 * invisible from there, so letting it silently shadow a running deployment would make the Config
 * tab lie about what the agent is using.
 */
export async function resolveWebTools(deps: WebToolsDeps, ownerId?: string): Promise<WebTools> {
  const env = deps.env ?? process.env;
  const deployments = await deps.db.getDeployments().catch(() => [] as DeploymentMetadata[]);

  const searxDep = liveDeployment(deployments, 'searxng', ownerId);
  const crawlDep = liveDeployment(deployments, 'crawl4ai', ownerId);

  const searxngUrl = (searxDep ? await baseUrlFor(deps, searxDep, 'searxng', 8080) : undefined)
    || env.SEARXNG_URL || undefined;

  const crawl4aiUrl = (crawlDep ? await baseUrlFor(deps, crawlDep, 'crawl4ai', 11235) : undefined)
    || env.CRAWL4AI_URL || undefined;

  // The token has to come from the same place the URL did. Pairing a deployment's URL with an
  // env var's token — or the reverse — authenticates against the wrong service and 401s on every
  // fetch, which then looks exactly like the crawler being down.
  const crawl4aiToken = (crawlDep && crawl4aiUrl && crawlDep.crawl4aiApiToken)
    || (!crawlDep ? env.CRAWL4AI_API_TOKEN : undefined)
    || undefined;

  const tools = createWebTools({
    ...(searxngUrl ? { searxngUrl } : {}),
    ...(crawl4aiUrl && crawl4aiToken ? { crawl4aiUrl, crawl4aiToken } : {}),
  });

  /**
   * Says which implementation won, every time.
   *
   * The whole reason these services exist is that the built-ins fail silently — a stripped page and
   * a page with nothing on it are the same bytes. A resolver that quietly falls back would
   * reintroduce exactly that, one level up: this line is how you tell "the crawler is not being
   * used" from "the crawler is being used and the page really is empty". It found a real bug the
   * first time it ran.
   */
  console.log(`[web-tools] search=${tools.sources.search} fetch=${tools.sources.fetch}`
    + ` (deployments: searxng=${searxDep ? searxDep.name : 'none'}, crawl4ai=${crawlDep ? crawlDep.name : 'none'})`);

  return tools;
}

/**
 * Where the crawler is, and the token for it — for callers that drive the JOB API rather than the
 * one-page fetch that `resolveWebTools` wraps.
 *
 * Deliberately returns both together. Pairing a deployment's URL with an environment variable's
 * token, or the reverse, authenticates against the wrong service and 401s on every call — a failure
 * this codebase has already had once.
 */
export async function crawlEndpoint(
  db: Pick<Database, 'getDeployments'>,
  ownerId?: string,
): Promise<{ base: string; token: string } | undefined> {
  const infra = new InfrastructureService();
  const clusters = new ClusterService(db as never, infra);
  const proxy = new ClusterProxyService();
  const deployments = await db.getDeployments().catch(() => [] as DeploymentMetadata[]);
  const dep = liveDeployment(deployments, 'crawl4ai', ownerId);
  if (!dep?.crawl4aiApiToken) return undefined;

  const url = await baseUrlFor(
    {
      db,
      ensurePortForward: (clusterId, serviceKey, kubeconfigPath, target) =>
        proxy.ensurePortForward(clusterId, serviceKey, kubeconfigPath, target),
      kubeconfigFor: async (clusterId: string) => {
        const cluster = await clusters.getByIdUnscoped(clusterId);
        return cluster ? clusters.getKubeconfigPath(cluster) : undefined;
      },
    },
    dep,
    'crawl4ai',
    11235,
  );
  // Trailing slash stripped: every path below is joined with one, and `//crawl/job` 404s.
  return url ? { base: url.replace(/\/+$/, ''), token: dep.crawl4aiApiToken } : undefined;
}

/**
 * Where this owner's corpus lives — all four services, resolved together.
 *
 * Together rather than one function each, because they are useless apart and a caller that got
 * three of them would have to decide what a corpus with no index means. `search` in
 * corpus-backend.ts wants storage AND an index in the same breath; an ingest wants all four.
 *
 * Every field is optional and the caller decides what it can do without: exact-term search needs
 * Quickwit, semantic needs Qdrant and TEI, and storing pages needs only MinIO. A partial corpus
 * degrades to fewer ways of asking rather than to an error.
 */
export interface CorpusEndpoints {
  storage?: { base: string; accessKey: string; secretKey: string; bucket: string };
  index?: { base: string };
  vectors?: { base: string; apiKey: string };
  embeddings?: { base: string };
}

export async function corpusEndpoints(
  db: Pick<Database, 'getDeployments'>,
  ownerId?: string,
): Promise<CorpusEndpoints> {
  const infra = new InfrastructureService();
  const clusters = new ClusterService(db as never, infra);
  const proxy = new ClusterProxyService();
  const deployments = await db.getDeployments().catch(() => [] as DeploymentMetadata[]);

  const deps: WebToolsDeps = {
    db,
    ensurePortForward: (clusterId, serviceKey, kubeconfigPath, target) =>
      proxy.ensurePortForward(clusterId, serviceKey, kubeconfigPath, target),
    kubeconfigFor: async (clusterId: string) => {
      const cluster = await clusters.getByIdUnscoped(clusterId);
      return cluster ? clusters.getKubeconfigPath(cluster) : undefined;
    },
  };

  const forward = async (appType: string, service: string, port: number) => {
    const dep = liveDeployment(deployments, appType, ownerId);
    if (!dep) return undefined;
    const url = await baseUrlFor(deps, dep, service, port);
    return url ? { dep, base: url.replace(/\/+$/, '') } : undefined;
  };

  // Resolved in parallel: each is a port-forward that may have to be established, and four in
  // series is four times the wait on the first call after a restart.
  const [minio, quickwit, qdrant, tei] = await Promise.all([
    forward('minio', 'minio', 9000),
    forward('quickwit', 'quickwit', 7280),
    forward('qdrant', 'qdrant', 6333),
    forward('tei', 'tei', 80),
  ]);

  return {
    ...(minio?.dep.minioRootPassword
      ? {
        storage: {
          base: minio.base,
          accessKey: minio.dep.minioRootUser || 'koala',
          secretKey: minio.dep.minioRootPassword,
          // The bucket Quickwit was configured with, so pages and indexes share one store.
          bucket: quickwit?.dep.quickwitBucket || 'koala-corpus',
        },
      }
      : {}),
    ...(quickwit ? { index: { base: quickwit.base } } : {}),
    ...(qdrant?.dep.qdrantApiKey ? { vectors: { base: qdrant.base, apiKey: qdrant.dep.qdrantApiKey } } : {}),
    ...(tei ? { embeddings: { base: tei.base } } : {}),
  };
}
