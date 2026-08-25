import { describe, it, expect } from 'vitest';
import { providersToSeed, BUILT_IN_PROVIDERS, type ClusterProviderSpec } from './cluster-providers.js';

describe('BUILT_IN_PROVIDERS', () => {
  it('covers the three providers the platform can provision today', () => {
    expect(BUILT_IN_PROVIDERS.map((p) => p.value).sort()).toEqual(['hetzner', 'k3d', 'remote']);
  });

  it('marks hetzner as the catalog-bearing, credentialed provider', () => {
    const hetzner = BUILT_IN_PROVIDERS.find((p) => p.value === 'hetzner')!;
    expect(hetzner.hasCatalog).toBe(true);
    expect(hetzner.usesMesh).toBe(false);
    expect(hetzner.credentialKey).toBe('hetzner');
  });

  it('marks k3d as needing neither credentials nor a catalog', () => {
    const k3d = BUILT_IN_PROVIDERS.find((p) => p.value === 'k3d')!;
    expect(k3d.hasCatalog).toBe(false);
    expect(k3d.credentialKey).toBeUndefined();
  });

  it('marks remote as mesh-backed without a catalog or stored credential', () => {
    const remote = BUILT_IN_PROVIDERS.find((p) => p.value === 'remote')!;
    expect(remote.usesMesh).toBe(true);
    expect(remote.hasCatalog).toBe(false);
    expect(remote.credentialKey).toBeUndefined();
  });
});

describe('providersToSeed', () => {
  it('offers everything when nothing is stored', () => {
    expect(providersToSeed([])).toHaveLength(BUILT_IN_PROVIDERS.length);
  });

  it('adds only what is missing from an existing store', () => {
    const stored: ClusterProviderSpec[] = [
      { value: 'k3d', label: 'Local (renamed by hand)', hasCatalog: false, usesMesh: false },
    ];
    const pending = providersToSeed(stored);
    expect(pending.map((p) => p.value)).toEqual(['hetzner', 'remote']);
  });

  it('leaves an edited built-in alone instead of overwriting it back', () => {
    // Every built-in stored under its own value counts as seeded, even when hand-edited —
    // here ALL of them are present (hetzner renamed), so there is nothing left to seed.
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
    void providersToSeed(stored); // first boot
    expect(providersToSeed([])).toEqual(providersToSeed([]));
  });
});
