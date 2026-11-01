import { describe, expect, it } from 'vitest';
import { clusterBuilt } from '../../packages/cdktf-infra/constructs/cluster.js';
import { CLUSTER_BUILDS, CLUSTER_PROVIDER_NAMES, providerReady } from '../../apps/backend/src/infrastructure/lib/cluster-topology.js';
import { BUILT_IN_PROVIDERS } from '../../apps/backend/src/infrastructure/lib/cluster-providers.js';
import { OVH_DEFAULT_SUBSIDIARY, vpsCatalogAdapters } from '../../apps/backend/src/infrastructure/lib/vps-catalog/adapters.js';

describe('the providers Koala offers to make a cluster on', () => {
  it('are exactly those whose cluster construct builds something, so none is offered while it is a stub', () => {
    for (const provider of CLUSTER_PROVIDER_NAMES) {
      expect(providerReady(provider), provider).toBe(clusterBuilt(provider));
    }
    expect(Object.keys(CLUSTER_BUILDS).sort()).toEqual([...CLUSTER_PROVIDER_NAMES].sort());
  });

  it('are the only ones Provision a cluster lists and the only ones the catalogue lets a cluster be made from', () => {
    expect(BUILT_IN_PROVIDERS.filter((provider) => !providerReady(provider.value))).toEqual([]);
    for (const adapter of vpsCatalogAdapters(() => OVH_DEFAULT_SUBSIDIARY)) expect(adapter.provisionable, adapter.provider).toBe(providerReady(adapter.provider));
  });
});
