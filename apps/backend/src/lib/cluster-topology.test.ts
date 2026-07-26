import { describe, it, expect } from 'vitest';
import { NEVER_MOCK_PROVIDERS, isMockCloudProvider, isSelfManagedCluster } from './cluster-topology.js';
import { buildAppEnv } from './app-env.js';

/**
 * These predicates were open-coded in ~20 places and acquired a silent bug every time a provider
 * was added and one copy was missed. The tests below pin the two failures that actually happened,
 * so a third provider can't reintroduce them.
 */
describe('cluster-topology', () => {
  const noCredentials = () => false;
  const hasCredentials = () => true;

  describe('isMockCloudProvider', () => {
    it.each(NEVER_MOCK_PROVIDERS)('never treats %s as mock cloud, even with no credentials', (provider) => {
      // 'remote' failing this made reconciliation look for a k3d container that never existed,
      // conclude the cluster was deleted, and erase the record. 'hetzner' would fail identically —
      // and would additionally orphan a running, billing VM.
      expect(isMockCloudProvider(provider, noCredentials)).toBe(false);
    });

    it('treats an uncredentialed real cloud provider as mock', () => {
      expect(isMockCloudProvider('aws', noCredentials)).toBe(true);
      expect(isMockCloudProvider('gcp', noCredentials)).toBe(true);
    });

    it('treats a credentialed cloud provider as real', () => {
      expect(isMockCloudProvider('aws', hasCredentials)).toBe(false);
    });
  });

  describe('isSelfManagedCluster', () => {
    it.each(NEVER_MOCK_PROVIDERS)('%s is self-managed', (provider) => {
      expect(isSelfManagedCluster(provider, false)).toBe(true);
    });

    it('a mock-cloud provider is self-managed (it is a local k3d container)', () => {
      expect(isSelfManagedCluster('aws', true)).toBe(true);
    });

    it('a real cloud provider with credentials is not self-managed', () => {
      expect(isSelfManagedCluster('aws', false)).toBe(false);
    });
  });
});

describe('buildAppEnv provider handling', () => {
  const base = {
    physicalName: 'c1',
    strategy: 'native',
    sanitizedName: 'app',
    deploymentId: 'dep1',
    kubeconfigPath: '/tmp/kubeconfig-c1',
    appType: 'audiobookshelf',
    tabbyGpuCount: 0,
    storageEnv: {},
  } as any;

  // The regression this whole module exists for: with SELF_MANAGED_K8S 'false', every app
  // construct picks a LoadBalancer Service, which on single-node k3s hangs forever waiting for an
  // external IP that no controller will ever assign.
  it.each(['k3d', 'remote', 'hetzner'])('sets SELF_MANAGED_K8S=true for %s', (provider) => {
    expect(buildAppEnv({ ...base, provider, isMock: false }).SELF_MANAGED_K8S).toBe('true');
  });

  it('sets SELF_MANAGED_K8S=true for a mock-cloud provider', () => {
    expect(buildAppEnv({ ...base, provider: 'aws', isMock: true }).SELF_MANAGED_K8S).toBe('true');
  });

  it('sets SELF_MANAGED_K8S=false for a real cloud provider', () => {
    expect(buildAppEnv({ ...base, provider: 'aws', isMock: false }).SELF_MANAGED_K8S).toBe('false');
  });

  // Distinct from SELF_MANAGED_K8S: this one selects a real kubeconfig context, and must stay
  // empty for remote/hetzner whose kubeconfigs have no "k3d-..." context to select.
  it('leaves KUBECONFIG_CONTEXT empty for remote and hetzner', () => {
    expect(buildAppEnv({ ...base, provider: 'remote', isMock: false }).KUBECONFIG_CONTEXT).toBe('');
    expect(buildAppEnv({ ...base, provider: 'hetzner', isMock: false }).KUBECONFIG_CONTEXT).toBe('');
    expect(buildAppEnv({ ...base, provider: 'k3d', isMock: false }).KUBECONFIG_CONTEXT).toBe('k3d-c1');
  });
});
