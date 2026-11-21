
export const NO_SERVICE_HOST = '127.0.0.1:1';

export const TEST_RELEASE = { imageTag: 'dev', registry: '127.0.0.1:5001' };

export const NO_SERVICE = `http://${NO_SERVICE_HOST}`;

export function unreachedPlatformServices(backend: string = NO_SERVICE): Record<string, string> {
  return {
    GITEA_URL: NO_SERVICE,
    GITEA_REACHES_KOALA_AT: backend,
    INFISICAL_URL: NO_SERVICE,
    KOALA_REGISTRY: NO_SERVICE_HOST,
    KOALA_REGISTRY_PUSH: NO_SERVICE_HOST,
    REGISTRY_PULL_HOST: NO_SERVICE_HOST,
    SEARXNG_URL: NO_SERVICE,
    CRAWL4AI_URL: NO_SERVICE,
    CRAWL4AI_API_TOKEN: 'no-crawl4ai-here',
    QDRANT_API_KEY: 'noQdrantHere',
    QUICKWIT_URL: NO_SERVICE,
    QDRANT_URL: NO_SERVICE,
    TEI_URL: NO_SERVICE,
    CHECKS_API_URL: `${backend}/api`,
  };
}
