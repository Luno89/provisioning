import { describe, it, expect } from 'vitest';
import { providersToSeed, BUILT_IN_PROVIDERS, type ClusterProviderSpec } from './cluster-providers.js';

describe('BUILT_IN_PROVIDERS', () => {
  it('covers the four providers the platform can provision today', () => {
    expect(BUILT_IN_PROVIDERS.map((p) => p.value).sort()).toEqual(['do', 'hetzner', 'k3d']);
  });

  it('marks DigitalOcean as catalog-bearing and credentialed, like Hetzner', () => {
    const ocean = BUILT_IN_PROVIDERS.find((p) => p.value === 'do')!;
    expect(ocean).toMatchObject({ hasCatalog: true, credentialKey: 'do' });
  });

  it('marks hetzner as the catalog-bearing, credentialed provider', () => {
    const hetzner = BUILT_IN_PROVIDERS.find((p) => p.value === 'hetzner')!;
    expect(hetzner.hasCatalog).toBe(true);
    expect(hetzner.credentialKey).toBe('hetzner');
  });

  it('marks k3d as needing neither credentials nor a catalog', () => {
    const k3d = BUILT_IN_PROVIDERS.find((p) => p.value === 'k3d')!;
    expect(k3d.hasCatalog).toBe(false);
    expect(k3d.credentialKey).toBeUndefined();
  });

});

describe('providersToSeed', () => {
  it('offers everything when nothing is stored', () => {
    expect(providersToSeed([])).toHaveLength(BUILT_IN_PROVIDERS.length);
  });

  it('adds only what is missing from an existing store', () => {
    const stored: ClusterProviderSpec[] = [
      { value: 'k3d', label: 'Local (renamed by hand)', hasCatalog: false },
    ];
    const pending = providersToSeed(stored);
    expect(pending.map((p) => p.value)).toEqual(['hetzner', 'do']);
  });

  it('leaves an edited built-in alone instead of overwriting it back', () => {
    const editedHetzner: ClusterProviderSpec = {
      ...BUILT_IN_PROVIDERS.find((p) => p.value === 'hetzner')!,
      label: 'My Hetzner',
    };
    const allStored = BUILT_IN_PROVIDERS.map((p) =>
      p.value === 'hetzner' ? editedHetzner : p,
    );
    expect(providersToSeed(allStored)).toEqual([]);
  });

  it('is stable when run twice against the same store (idempotent)', () => {
    const stored: ClusterProviderSpec[] = [];
    void providersToSeed(stored);
    expect(providersToSeed([])).toEqual(providersToSeed([]));
  });
});
