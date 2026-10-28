import { describe, expect, it } from 'vitest';
import { minioStorageFor, specStorageFor } from './app-storage.js';
import { BUILT_IN_SPECS, renderApp } from './app-spec.js';

describe('how much a MinIO keeps', () => {
  it('is 10 GB on Koala\'s servers, whatever was asked, and what was asked anywhere else', () => {
    expect(minioStorageFor(true, '500Gi')).toBe('10Gi');
    expect(minioStorageFor(true)).toBe('10Gi');
    expect(minioStorageFor(false, '50Gi')).toBe('50Gi');
    expect(minioStorageFor(false)).toBeUndefined();
    expect(specStorageFor('minio', true, {})).toEqual({ '/data': '10Gi' });
    expect(specStorageFor('nextcloud', true, {})).toBeUndefined();
    expect(specStorageFor('minio', false, {})).toBeUndefined();
  });

  it('sizes the volume MinIO\'s spec claims', () => {
    const spec = BUILT_IN_SPECS.find((one) => one.id === 'minio');
    expect(spec).toBeDefined();
    const rendered = renderApp(spec!, { id: 'd1', namespace: 'ns', serviceType: 'ClusterIP', secrets: {}, storage: specStorageFor('minio', true, {})! });
    expect(rendered.pvcs.map((pvc) => (pvc.spec as { resources: { requests: { storage: string } } }).resources.requests.storage)).toEqual(['10Gi']);
  });
});
