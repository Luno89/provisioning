import { describe, expect, it } from 'vitest';
import { goneImages, goneMessage, manifestAnswer, pinnedImageOf, registryReachOf, type PinnedImage } from './pinned-images.js';

const VLLM = 'b'.repeat(64);
const TABBY = 'c'.repeat(64);
const sources = { dockerHub: 'https://registry-1.docker.io', dockerAuth: 'https://auth.docker.io', ghcr: 'https://ghcr.io' };

const vllm: PinnedImage = { image: 'vllm/vllm-openai', source: 'docker.io/vllm/vllm-openai:v0.32.0', host: 'docker.io', repository: 'vllm/vllm-openai', digest: VLLM };

describe('an image Koala pins by digest', () => {
  it('reads the registry, repository and digest from the pin, whether the digest is its checksum or in its source', () => {
    expect(pinnedImageOf({ kind: 'image', name: 'vllm/vllm-openai', source: 'docker.io/vllm/vllm-openai:v0.32.0', digest: VLLM })).toEqual(vllm);
    expect(pinnedImageOf({ kind: 'image', name: 'theroyallab/tabbyapi', source: `ghcr.io/theroyallab/tabbyapi@sha256:${TABBY}` }))
      .toEqual({ image: 'theroyallab/tabbyapi', source: `ghcr.io/theroyallab/tabbyapi@sha256:${TABBY}`, host: 'ghcr.io', repository: 'theroyallab/tabbyapi', digest: TABBY });
    expect(pinnedImageOf({ kind: 'image', name: 'registry', source: 'docker.io/registry:2', digest: VLLM })).toMatchObject({ host: 'docker.io', repository: 'library/registry' });
  });

  it('is not one when it names no digest, or is not an image', () => {
    expect(pinnedImageOf({ kind: 'image', name: 'mongo', source: 'docker.io/library/mongo:7' })).toBeUndefined();
    expect(pinnedImageOf({ kind: 'binary', name: 'k3s', source: 'https://example.invalid/k3s', digest: VLLM })).toBeUndefined();
    expect(pinnedImageOf({ kind: 'image', name: 'x', digest: VLLM })).toBeUndefined();
  });

  it('is asked of Docker Hub through its token service, and of GHCR through its own, anonymously', () => {
    expect(registryReachOf('docker.io', 'vllm/vllm-openai', sources)).toEqual({ registry: 'https://registry-1.docker.io', token: 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:vllm/vllm-openai:pull' });
    expect(registryReachOf('ghcr.io', 'theroyallab/tabbyapi', sources)).toEqual({ registry: 'https://ghcr.io', token: 'https://ghcr.io/token?scope=repository:theroyallab/tabbyapi:pull' });
    expect(registryReachOf('nvcr.io', 'nvidia/k8s-device-plugin', sources)).toBeUndefined();
  });
});

describe('what a registry\'s answer about a digest means', () => {
  it('is there when it serves the manifest, and gone only on a 404 or MANIFEST_UNKNOWN', () => {
    expect(manifestAnswer(200, {})).toBe('present');
    expect(manifestAnswer(404, undefined)).toBe('gone');
    expect(manifestAnswer(400, { errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown' }] })).toBe('gone');
  });

  it('says nothing about the digest on any other answer', () => {
    expect(manifestAnswer(401, { errors: [{ code: 'UNAUTHORIZED' }] })).toBeUndefined();
    expect(manifestAnswer(429, undefined)).toBeUndefined();
    expect(manifestAnswer(503, undefined)).toBeUndefined();
  });
});

describe('pinned digests gone upstream, from one check to the next', () => {
  const at = (iso: string) => new Date(iso);

  it('keeps since when a digest has been gone, tells only the first time, and clears it once it answers or its pin changes', () => {
    const first = goneImages([], [{ pinned: vllm, releases: ['v2026.11.13'], state: 'gone' }], at('2026-11-14T06:00:00Z'));
    expect(first).toEqual({ gone: [{ image: 'vllm/vllm-openai', source: 'docker.io/vllm/vllm-openai:v0.32.0', digest: VLLM, since: '2026-11-14T06:00:00.000Z', releases: ['v2026.11.13'] }], fresh: first.gone });
    const next = goneImages(first.gone, [{ pinned: vllm, releases: ['v2026.11.13'], state: 'gone' }], at('2026-11-15T06:00:00Z'));
    expect(next).toEqual({ gone: first.gone, fresh: [] });
    expect(goneImages(first.gone, [{ pinned: vllm, releases: ['v2026.11.13'], state: 'present' }], at('2026-11-15T06:00:00Z'))).toEqual({ gone: [], fresh: [] });
    expect(goneImages(first.gone, [], at('2026-11-15T06:00:00Z'))).toEqual({ gone: [], fresh: [] });
  });

  it('keeps a digest known gone while its registry cannot be asked, and starts none on a check that could not be made', () => {
    const first = goneImages([], [{ pinned: vllm, releases: ['v2026.11.13'], state: 'gone' }], at('2026-11-14T06:00:00Z'));
    expect(goneImages(first.gone, [{ pinned: vllm, releases: ['v2026.11.13'], state: 'unchecked' }], at('2026-11-15T06:00:00Z'))).toEqual({ gone: first.gone, fresh: [] });
    expect(goneImages([], [{ pinned: vllm, releases: ['v2026.11.13'], state: 'unchecked' }], at('2026-11-15T06:00:00Z'))).toEqual({ gone: [], fresh: [] });
  });

  it('emails the operator what is gone, what it means for a deploy and what to do', () => {
    const { fresh } = goneImages([], [{ pinned: vllm, releases: ['v2026.11.13'], state: 'gone' }], at('2026-11-14T06:00:00Z'));
    expect(goneMessage(fresh, 'https://app.example.com')).toEqual({
      subject: 'Koala\'s dependencies: 1 pinned image gone upstream',
      text: [
        'Koala\'s daily check found that its registry no longer has an image Koala pins by digest:',
        '',
        `- vllm/vllm-openai@sha256:${VLLM.slice(0, 12)} (docker.io/vllm/vllm-openai:v0.32.0), pinned in v2026.11.13`,
        '',
        'A machine that has not pulled it already cannot deploy it: the deploy fails saying the image could not be pulled. Pin a digest the registry still has in dependencies.pins.json, then release.',
        'See it on Koala\'s dependencies: https://app.example.com/#/dependencies',
      ].join('\n'),
    });
    expect(goneMessage([], 'https://app.example.com')).toBeUndefined();
    expect(goneMessage([...fresh, { ...fresh[0]!, image: 'theroyallab/tabbyapi' }], '')?.subject).toBe('Koala\'s dependencies: 2 pinned images gone upstream');
  });
});
