import type { DependencySources, InventoryComponent } from '../../platform/index.js';

export interface PinnedImage {
  image: string;
  source: string;
  host: string;
  repository: string;
  digest: string;
}

export interface RegistryReach {
  registry: string;
  token: string;
}

export type DigestState = 'present' | 'gone' | 'unchecked';

export interface DigestSeen {
  pinned: PinnedImage;
  releases: string[];
  state: DigestState;
}

export interface GoneImage {
  image: string;
  source: string;
  digest: string;
  since: string;
  releases: string[];
}

export const MANIFESTS = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

const DIGEST = /^[0-9a-f]{64}$/;

export function pinnedImageOf(component: Pick<InventoryComponent, 'kind' | 'name' | 'source' | 'digest'>): PinnedImage | undefined {
  if (component.kind !== 'image' || !component.source) return undefined;
  const [reference, inSource] = component.source.split('@sha256:');
  const digest = component.digest ?? inSource;
  if (!reference || !digest || !DIGEST.test(digest)) return undefined;
  const slash = reference.indexOf('/');
  if (slash <= 0) return undefined;
  const host = reference.slice(0, slash);
  const path = reference.slice(slash + 1).replace(/:[^/:]+$/, '');
  const repository = host === 'docker.io' && !path.includes('/') ? `library/${path}` : path;
  return { image: component.name, source: component.source, host, repository, digest };
}

export function registryReachOf(host: string, repository: string, sources: Pick<DependencySources, 'dockerHub' | 'dockerAuth' | 'ghcr'>): RegistryReach | undefined {
  if (host === 'docker.io') return { registry: sources.dockerHub, token: `${sources.dockerAuth}/token?service=registry.docker.io&scope=repository:${repository}:pull` };
  if (host === 'ghcr.io') return { registry: sources.ghcr, token: `${sources.ghcr}/token?scope=repository:${repository}:pull` };
  return undefined;
}

const saysUnknown = (body: unknown): boolean => {
  const errors = (body as { errors?: unknown } | undefined)?.errors;
  return Array.isArray(errors) && errors.some((entry) => (entry as { code?: unknown } | undefined)?.code === 'MANIFEST_UNKNOWN');
};

export function manifestAnswer(status: number, body: unknown): 'present' | 'gone' | undefined {
  if (status >= 200 && status < 300) return 'present';
  if (status === 404 || saysUnknown(body)) return 'gone';
  return undefined;
}

const sameImage = (gone: Pick<GoneImage, 'image' | 'digest'>, pinned: PinnedImage): boolean => gone.image === pinned.image && gone.digest === pinned.digest;

export function goneImages(previous: readonly GoneImage[], seen: readonly DigestSeen[], now: Date): { gone: GoneImage[]; fresh: GoneImage[] } {
  const gone: GoneImage[] = [];
  const fresh: GoneImage[] = [];
  for (const { pinned, releases, state } of seen) {
    const before = previous.find((entry) => sameImage(entry, pinned));
    if (state === 'present' || (state === 'unchecked' && !before)) continue;
    const entry: GoneImage = { image: pinned.image, source: pinned.source, digest: pinned.digest, since: before?.since ?? now.toISOString(), releases };
    gone.push(entry);
    if (!before) fresh.push(entry);
  }
  return { gone, fresh };
}

export const shortDigest = (digest: string): string => `sha256:${digest.slice(0, 12)}`;

export function goneMessage(fresh: readonly GoneImage[], rootUrl: string): { subject: string; text: string } | undefined {
  if (fresh.length === 0) return undefined;
  return {
    subject: `Koala's dependencies: ${fresh.length} pinned image${fresh.length === 1 ? '' : 's'} gone upstream`,
    text: [
      'Koala\'s daily check found that its registry no longer has an image Koala pins by digest:',
      '',
      ...fresh.map((entry) => `- ${entry.image}@${shortDigest(entry.digest)} (${entry.source}), pinned in ${entry.releases.join(', ')}`),
      '',
      'A machine that has not pulled it already cannot deploy it: the deploy fails saying the image could not be pulled. Pin a digest the registry still has in dependencies.pins.json, then release.',
      ...(rootUrl ? [`See it on Koala's dependencies: ${rootUrl}/#/dependencies`] : []),
    ].join('\n'),
  };
}
