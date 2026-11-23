import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMAGE_CACHES, imageMirrorsOnThisComputer } from './image-caches.js';

const pins = JSON.parse(readFileSync(new URL('../../../../../dependencies.pins.json', import.meta.url), 'utf8')) as { components: { kind: string; source?: string }[] };

const registryOf = (image: string): string => {
  const [first, ...rest] = image.split('/');
  return rest.length > 0 && first!.includes('.') ? first! : 'docker.io';
};

const cached = new Set<string>(IMAGE_CACHES.map((cache) => cache.registry));

describe('the image caches on this computer', () => {
  it('cover every registry an image the pins file names comes from, the GPU device plugins, vLLM and TabbyAPI among them', () => {
    const registries = new Set(pins.components.filter((component) => component.kind === 'image' && component.source).map((component) => registryOf(component.source!)));
    expect([...registries].filter((registry) => !cached.has(registry))).toEqual([]);
    expect(registries.has('nvcr.io')).toBe(true);
  });

  it('cover the registries the Gitea and Infisical charts pull their own images from', () => {
    expect(['docker.gitea.com', 'mirror.gcr.io'].filter((registry) => !cached.has(registry))).toEqual([]);
  });

  it('each answer on a port of its own, pulling from its registry over https', () => {
    expect(new Set(IMAGE_CACHES.map((cache) => cache.port)).size).toBe(IMAGE_CACHES.length);
    for (const cache of IMAGE_CACHES) expect(cache.upstream).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    expect(imageMirrorsOnThisComputer()['nvcr.io']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
