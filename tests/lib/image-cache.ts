import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const IMAGE_CACHES = [
  { registry: 'docker.io', upstream: 'https://registry-1.docker.io', port: 5101 },
  { registry: 'ghcr.io', upstream: 'https://ghcr.io', port: 5102 },
  { registry: 'quay.io', upstream: 'https://quay.io', port: 5103 },
  { registry: 'registry.k8s.io', upstream: 'https://registry.k8s.io', port: 5104 },
  { registry: 'gcr.io', upstream: 'https://gcr.io', port: 5105 },
] as const;

const REGISTRY_IMAGE = 'registry:2';

export function hostFromVm(network = '10.0.2.0/24'): string {
  const [base] = network.split('/');
  const parts = (base ?? '').split('.');
  if (parts.length !== 4) throw new Error(`not an IPv4 network: ${network}`);
  return [...parts.slice(0, 3), '2'].join('.');
}

const containerOf = (registry: string) => `koala-image-cache-${registry.replace(/\./g, '-')}`;

async function state(name: string): Promise<string | undefined> {
  try {
    return (await run('docker', ['inspect', '--format', '{{.State.Status}}', name])).stdout.trim();
  } catch {
    return undefined;
  }
}

export async function ensureImageCaches(): Promise<void> {
  for (const cache of IMAGE_CACHES) {
    const name = containerOf(cache.registry);
    const now = await state(name);
    if (now === 'running') continue;
    if (now) {
      await run('docker', ['start', name]);
      continue;
    }
    await run('docker', [
      'run', '-d', '--name', name, '--restart', 'unless-stopped',
      '-p', `127.0.0.1:${cache.port}:5000`,
      '-v', `${name}:/var/lib/registry`,
      '-e', `REGISTRY_PROXY_REMOTEURL=${cache.upstream}`,
      REGISTRY_IMAGE,
    ]);
  }
}

export function registriesYamlForVm(host: string): string {
  return ['mirrors:', ...IMAGE_CACHES.flatMap((cache) => [
    `  "${cache.registry}":`,
    '    endpoint:',
    `      - "http://${host}:${cache.port}"`,
  ])].join('\n');
}
