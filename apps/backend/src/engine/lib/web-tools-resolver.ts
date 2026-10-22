import type { Database } from '../../platform/lib/db-interface.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import { createWebTools, type WebTools } from './web-tools.js';

export interface ProxyTarget {
  service: string;
  namespace: string;
  remotePort: number;
}

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export interface WebToolsDeps {
  db: Pick<Database, 'infrastructure'>;
  serviceUrl: (clusterId: string, serviceKey: string, kubeconfigPath: string, target: ProxyTarget) => Promise<string>;
  kubeconfigFor: (clusterId: string) => Promise<string | undefined>;
  env?: NodeJS.ProcessEnv;
}

export function webToolsDepsFrom(
  db: Pick<Database, 'infrastructure'>,
  clusters: { getByIdUnscoped(id: string): Promise<ClusterMetadata | undefined | null>; getKubeconfigPath(cluster: ClusterMetadata): string | Promise<string | undefined> | undefined },
  proxy: { serviceUrl(clusterId: string, serviceKey: string, kubeconfigPath: string, target: ProxyTarget): Promise<string> },
): WebToolsDeps {
  return {
    db,
    serviceUrl: (clusterId, serviceKey, kubeconfigPath, target) => proxy.serviceUrl(clusterId, serviceKey, kubeconfigPath, target),
    kubeconfigFor: async (clusterId) => {
      const cluster = await clusters.getByIdUnscoped(clusterId);
      return cluster ? await clusters.getKubeconfigPath(cluster) : undefined;
    },
  };
}

export function liveDeployment(deployments: DeploymentMetadata[], appType: string, ownerId?: string): DeploymentMetadata | undefined {
  return deployments.find((d) =>
    d.appType === appType
    && d.status === 'running'
    && d.clusterId
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
      console.warn(`[web-tools] ${service} deployment "${dep.name}" has no resolvable kubeconfig for cluster ${dep.clusterId}`);
      return undefined;
    }
    const ns = sanitize(dep.name);
    const url = await deps.serviceUrl(dep.clusterId!, `${service}-${dep.id}`, kubeconfig, {
      service, namespace: ns, remotePort,
    });
    return url.replace(/\/$/, '');
  } catch (err) {
    console.warn(`[web-tools] could not reach ${service} deployment "${dep.name}": ${(err as Error).message}`);
    return undefined;
  }
}

export async function resolveWebTools(deps: WebToolsDeps, ownerId?: string): Promise<WebTools> {
  const env = deps.env ?? process.env;
  const deployments = await deps.db.infrastructure.getDeployments().catch(() => [] as DeploymentMetadata[]);

  const searxDep = liveDeployment(deployments, 'searxng', ownerId);
  const crawlDep = liveDeployment(deployments, 'crawl4ai', ownerId);

  const searxngUrl = (searxDep ? await baseUrlFor(deps, searxDep, 'searxng', 8080) : undefined)
    || env.SEARXNG_URL || undefined;

  const crawl4aiUrl = (crawlDep ? await baseUrlFor(deps, crawlDep, 'crawl4ai', 11235) : undefined)
    || env.CRAWL4AI_URL || undefined;

  const crawl4aiToken = (crawlDep && crawl4aiUrl && crawlDep.crawl4aiApiToken)
    || (!crawlDep ? env.CRAWL4AI_API_TOKEN : undefined)
    || undefined;

  const tools = createWebTools({
    ...(searxngUrl ? { searxngUrl } : {}),
    ...(crawl4aiUrl && crawl4aiToken ? { crawl4aiUrl, crawl4aiToken } : {}),
  });

  console.log(`[web-tools] search=${tools.sources.search} fetch=${tools.sources.fetch}`
    + ` (deployments: searxng=${searxDep ? searxDep.name : 'none'}, crawl4ai=${crawlDep ? crawlDep.name : 'none'})`);

  return tools;
}

export async function crawlEndpointWith(deps: WebToolsDeps, ownerId?: string): Promise<{ base: string; token: string } | undefined> {
  const deployments = await deps.db.infrastructure.getDeployments().catch(() => [] as DeploymentMetadata[]);
  const dep = liveDeployment(deployments, 'crawl4ai', ownerId);
  if (!dep?.crawl4aiApiToken) return undefined;
  const url = await baseUrlFor(deps, dep, 'crawl4ai', 11235);
  return url ? { base: url.replace(/\/+$/, ''), token: dep.crawl4aiApiToken } : undefined;
}

export interface CorpusEndpoints {
  storage?: { base: string; accessKey: string; secretKey: string; bucket: string };
  index?: { base: string };
  vectors?: { base: string; apiKey: string };
  embeddings?: { base: string };
}

export async function corpusEndpointsWith(deps: WebToolsDeps, ownerId?: string): Promise<CorpusEndpoints> {
  const deployments = await deps.db.infrastructure.getDeployments().catch(() => [] as DeploymentMetadata[]);

  const forward = async (appType: string, service: string, port: number) => {
    const dep = liveDeployment(deployments, appType, ownerId);
    if (!dep) return undefined;
    const url = await baseUrlFor(deps, dep, service, port);
    return url ? { dep, base: url.replace(/\/+$/, '') } : undefined;
  };

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
          bucket: quickwit?.dep.quickwitBucket || 'koala-corpus',
        },
      }
      : {}),
    ...(quickwit ? { index: { base: quickwit.base } } : {}),
    ...(qdrant?.dep.qdrantApiKey ? { vectors: { base: qdrant.base, apiKey: qdrant.dep.qdrantApiKey } } : {}),
    ...(tei ? { embeddings: { base: tei.base } } : {}),
  };
}
