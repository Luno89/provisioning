export const IMAGE_CACHES = [
  { registry: 'docker.io', upstream: 'https://registry-1.docker.io', port: 5101 },
  { registry: 'ghcr.io', upstream: 'https://ghcr.io', port: 5102 },
  { registry: 'quay.io', upstream: 'https://quay.io', port: 5103 },
  { registry: 'registry.k8s.io', upstream: 'https://registry.k8s.io', port: 5104 },
  { registry: 'gcr.io', upstream: 'https://gcr.io', port: 5105 },
] as const;

export const imageMirrorsOnThisComputer = (): Record<string, string> =>
  Object.fromEntries(IMAGE_CACHES.map((cache) => [cache.registry, `http://127.0.0.1:${cache.port}`]));
