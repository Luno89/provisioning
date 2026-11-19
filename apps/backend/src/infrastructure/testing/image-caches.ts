import { localCommands } from '@koala/provision';
import { containersOn, type Containers } from '@koala/provision/testing';

export const IMAGE_CACHES = [
  { registry: 'docker.io', upstream: 'https://registry-1.docker.io', port: 5101 },
  { registry: 'ghcr.io', upstream: 'https://ghcr.io', port: 5102 },
  { registry: 'quay.io', upstream: 'https://quay.io', port: 5103 },
  { registry: 'registry.k8s.io', upstream: 'https://registry.k8s.io', port: 5104 },
  { registry: 'gcr.io', upstream: 'https://gcr.io', port: 5105 },
] as const;

const REGISTRY_IMAGE = 'registry:2';

export const imageCacheContainer = (registry: string): string => `koala-image-cache-${registry.replace(/\./g, '-')}`;

export async function ensureImageCaches(containers: Containers = containersOn(localCommands(process.env))): Promise<void> {
  for (const cache of IMAGE_CACHES) {
    const name = imageCacheContainer(cache.registry);
    const now = (await containers.status(name))?.state;
    if (now === 'running') continue;
    if (now) {
      await containers.start(name);
      continue;
    }
    await containers.run(name, [
      '--restart', 'unless-stopped',
      '-p', `127.0.0.1:${cache.port}:5000`,
      '-v', `${name}:/var/lib/registry`,
      '-e', `REGISTRY_PROXY_REMOTEURL=${cache.upstream}`,
      REGISTRY_IMAGE,
    ]);
  }
}
