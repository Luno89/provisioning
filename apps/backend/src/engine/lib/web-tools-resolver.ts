import type { DeploymentMetadata } from '../../platform/index.js';
import { createWebTools, type WebTools } from './web-tools.js';
import type { InfrastructureStore } from '../../infrastructure/index.js';
import { namespaceOf } from '../../infrastructure/lib/app-namespace.js';
import { reportingFetch, type DependencyReporter } from '../../platform/lib/dependencies.js';
import { CorpusStoreDown } from './corpus-stores.js';

export interface ProxyTarget {
  service: string;
  namespace: string;
  remotePort: number;
}


export interface WebToolsDeps {
  db: Pick<InfrastructureStore, 'getDeployments'>;
  serviceUrl: (clusterId: string, serviceKey: string, target: ProxyTarget) => Promise<string>;
  settings?: { searxngUrl?: string | undefined; crawl4aiUrl?: string | undefined; crawl4aiToken?: string | undefined } | undefined;
  pageCheck?: ((url: string) => Promise<string | undefined>) | undefined;
  dependencies?: DependencyReporter | undefined;
  baseFetch?: typeof fetch | undefined;
}

export function webToolsDepsFrom(
  db: Pick<InfrastructureStore, 'getDeployments'>,
  proxy: { serviceUrl(clusterId: string, serviceKey: string, target: ProxyTarget): Promise<string> },
): WebToolsDeps {
  return {
    db,
    serviceUrl: (clusterId, serviceKey, target) => proxy.serviceUrl(clusterId, serviceKey, target),
  };
}

export function liveDeployment(deployments: DeploymentMetadata[], appType: string, ownerId: string): DeploymentMetadata | undefined {
  return deployments.find((d) =>
    d.appType === appType
    && d.status === 'running'
    && d.clusterId
    && d.ownerId === ownerId);
}

const SERVICE_NAMES: Record<string, string> = { minio: 'MinIO', quickwit: 'Quickwit', qdrant: 'Qdrant', tei: 'TEI' };

async function baseUrlFor(
  deps: WebToolsDeps,
  dep: DeploymentMetadata,
  service: string,
  remotePort: number,
): Promise<string> {
  try {
    const url = await deps.serviceUrl(dep.clusterId, `${service}-${dep.id}`, {
      service, namespace: namespaceOf(dep), remotePort,
    });
    return url.replace(/\/+$/, '');
  } catch (err) {
    throw new CorpusStoreDown(`${SERVICE_NAMES[service] ?? service} "${dep.name}" is deployed but not answering: ${(err as Error).message}`, { cause: err });
  }
}

export async function resolveWebTools(deps: WebToolsDeps): Promise<WebTools> {
  const { searxngUrl, crawl4aiUrl, crawl4aiToken } = deps.settings ?? {};
  const watched = (dependency: 'searxng' | 'crawl4ai'): typeof fetch | undefined =>
    deps.dependencies && deps.baseFetch ? reportingFetch(deps.dependencies, dependency, deps.baseFetch) : undefined;
  const searxngFetch = searxngUrl ? watched('searxng') : undefined;
  const crawl4aiFetch = crawl4aiUrl ? watched('crawl4ai') : undefined;
  return createWebTools({
    ...(deps.baseFetch ? { fetchImpl: deps.baseFetch } : {}),
    ...(searxngFetch ? { searxngFetch } : {}),
    ...(crawl4aiFetch ? { crawl4aiFetch } : {}),
    ...(deps.pageCheck ? { pageCheck: deps.pageCheck } : {}),
    ...(searxngUrl ? { searxngUrl } : {}),
    ...(crawl4aiUrl && crawl4aiToken ? { crawl4aiUrl, crawl4aiToken } : {}),
  });
}

export interface CorpusEndpoints {
  storage?: { base: string; accessKey: string; secretKey: string; bucket: string };
  index?: { base: string };
  vectors?: { base: string; apiKey: string };
  embeddings?: { base: string };
}

export async function corpusEndpointsWith(deps: WebToolsDeps, ownerId: string): Promise<CorpusEndpoints> {
  const deployments = await deps.db.getDeployments();

  const forward = async (appType: string, service: string, port: number) => {
    const dep = liveDeployment(deployments, appType, ownerId);
    return dep ? { dep, base: await baseUrlFor(deps, dep, service, port) } : undefined;
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
