import { localCommands } from '@koala/provision';
import { containersOn, type Containers } from '@koala/provision/testing/containers';

import { IMAGE_CACHES } from '../lib/image-caches.js';

export { IMAGE_CACHES };

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
