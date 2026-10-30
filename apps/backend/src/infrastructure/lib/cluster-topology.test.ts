import { describe, it, expect } from 'vitest';
import { NEVER_MOCK_PROVIDERS, isMockCloudProvider, isSelfManagedCluster, provisionRefusal, withoutKeys } from './cluster-topology.js';
import { buildAppEnv } from './app-env.js';

describe('cluster-topology', () => {
  const noCredentials = () => false;
  const hasCredentials = () => true;

  describe('isMockCloudProvider', () => {
    it.each(NEVER_MOCK_PROVIDERS)('never treats %s as mock cloud, even with no credentials', (provider) => {
      expect(isMockCloudProvider(provider, noCredentials)).toBe(false);
    });

    it('treats an uncredentialed real cloud provider as mock', () => {
      expect(isMockCloudProvider('aws', noCredentials)).toBe(true);
      expect(isMockCloudProvider('gcp', noCredentials)).toBe(true);
    });

    it('treats a credentialed cloud provider as real', () => {
      expect(isMockCloudProvider('aws', hasCredentials)).toBe(false);
    });

    it('never mocks anything in production, so nothing there falls through to local k3d containers', () => {
      for (const provider of ['aws', 'gcp', 'azure', 'something-else']) {
        expect(isMockCloudProvider(provider, noCredentials, { NODE_ENV: 'production' })).toBe(false);
      }
      expect(isMockCloudProvider('aws', noCredentials, { NODE_ENV: 'development' })).toBe(true);
    });
  });

  describe('a cloud provider with no keys', () => {
    const production = { NODE_ENV: 'production' };

    it('runs in mock cloud mode on a dev box, and is refused in production', () => {
      expect(withoutKeys('aws', {})).toBe('mock');
      expect(withoutKeys('gcp', production)).toBe('refused');
      expect(withoutKeys('hetzner', production)).toBeUndefined();
      expect(withoutKeys('huggingface', production)).toBeUndefined();
    });

    it('is refused in production with where to add the keys, and only when no keys of the person\'s resolve', () => {
      expect(provisionRefusal('aws', 'mock', production)).toBe('Koala has no Amazon Web Services keys of yours to make this cluster with: add your Amazon Web Services keys under Cloud providers');
      expect(provisionRefusal('azure', 'mock', production)).toMatch(/add your Microsoft Azure keys under Cloud providers$/);
      expect(provisionRefusal('aws', 'user', production)).toBeUndefined();
      expect(provisionRefusal('aws', 'env', production)).toBeUndefined();
      expect(provisionRefusal('aws', 'mock', { NODE_ENV: 'development' })).toBeUndefined();
      expect(provisionRefusal('k3d', 'user', production)).toBeUndefined();
    });

    it('refuses a provider Koala does not make clusters on, anywhere', () => {
      expect(provisionRefusal('mars', 'user', {})).toBe('mars is not a provider Koala makes clusters on');
    });
  });

  describe('DigitalOcean', () => {
    it('is never mock, with or without credentials', () => {
      expect(isMockCloudProvider('do', noCredentials)).toBe(false);
      expect(isMockCloudProvider('do', hasCredentials)).toBe(false);
    });

    it('is self-managed, so apps get NodePort rather than a LoadBalancer that never resolves', () => {
      expect(isSelfManagedCluster('do', false)).toBe(true);
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
    namespace: 'app',
    deploymentId: 'dep1',
    kubeconfigPath: '/tmp/kubeconfig-c1',
    appType: 'audiobookshelf',
    tabbyGpuCount: 0,
    storageEnv: {},
  } as any;

  it.each(['k3d', 'remote', 'hetzner'])('sets SELF_MANAGED_K8S=true for %s', (provider) => {
    expect(buildAppEnv({ ...base, provider, isMock: false }).SELF_MANAGED_K8S).toBe('true');
  });

  it('sets SELF_MANAGED_K8S=true for a mock-cloud provider', () => {
    expect(buildAppEnv({ ...base, provider: 'aws', isMock: true }).SELF_MANAGED_K8S).toBe('true');
  });

  it('sets SELF_MANAGED_K8S=false for a real cloud provider', () => {
    expect(buildAppEnv({ ...base, provider: 'aws', isMock: false }).SELF_MANAGED_K8S).toBe('false');
  });

  it('leaves KUBECONFIG_CONTEXT empty for remote and hetzner', () => {
    expect(buildAppEnv({ ...base, provider: 'remote', isMock: false }).KUBECONFIG_CONTEXT).toBe('');
    expect(buildAppEnv({ ...base, provider: 'hetzner', isMock: false }).KUBECONFIG_CONTEXT).toBe('');
    expect(buildAppEnv({ ...base, provider: 'k3d', isMock: false }).KUBECONFIG_CONTEXT).toBe('k3d-c1');
  });
});
