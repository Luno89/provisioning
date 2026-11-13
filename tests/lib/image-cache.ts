import { IMAGE_CACHES } from '../../apps/backend/src/infrastructure/testing/image-caches.js';

export { ensureImageCaches, IMAGE_CACHES, imageCacheContainer } from '../../apps/backend/src/infrastructure/testing/image-caches.js';

export function hostFromVm(network = '10.0.2.0/24'): string {
  const [base] = network.split('/');
  const parts = (base ?? '').split('.');
  if (parts.length !== 4) throw new Error(`not an IPv4 network: ${network}`);
  return [...parts.slice(0, 3), '2'].join('.');
}

export function registriesYamlForVm(host: string): string {
  return ['mirrors:', ...IMAGE_CACHES.flatMap((cache) => [
    `  "${cache.registry}":`,
    '    endpoint:',
    `      - "http://${host}:${cache.port}"`,
  ])].join('\n');
}
