export const NO_SERVICE_HOST = '127.0.0.1:1';

export const NO_SERVICE = `http://${NO_SERVICE_HOST}`;

export function unreachedPlatformServices(backend: string = NO_SERVICE): Record<string, string> {
  return {
    GITEA_URL: NO_SERVICE,
    GITEA_REACHES_KOALA_AT: backend,
    INFISICAL_URL: NO_SERVICE,
    KOALA_REGISTRY: NO_SERVICE_HOST,
    KOALA_REGISTRY_PUSH: NO_SERVICE_HOST,
  };
}
