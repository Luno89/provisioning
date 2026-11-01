import { describe, it, expect } from 'vitest';
import { NEVER_MOCK_PROVIDERS, clusterAvailability, isMockCloudProviderIn, isSelfManagedCluster, providerReady, provisionRefusal } from './cluster-topology.js';
import { buildAppEnv, type AppEnvArgs } from './app-env.js';

describe('cluster-topology', () => {
  const noCredentials = () => false;
  const hasCredentials = () => true;

  describe('isMockCloudProvider', () => {
    it.each(NEVER_MOCK_PROVIDERS)('never treats %s as mock cloud, even with no credentials', (provider) => {
      expect(isMockCloudProviderIn(provider, noCredentials, {})).toBe(false);
    });

    it('treats an uncredentialed real cloud provider as mock', () => {
      expect(isMockCloudProviderIn('aws', noCredentials, {})).toBe(true);
      expect(isMockCloudProviderIn('gcp', noCredentials, {})).toBe(true);
    });

    it('treats a credentialed cloud provider as real', () => {
      expect(isMockCloudProviderIn('aws', hasCredentials, {})).toBe(false);
    });

    it('never mocks anything in production, so nothing there falls through to local k3d containers', () => {
      for (const provider of ['aws', 'gcp', 'azure', 'something-else']) {
        expect(isMockCloudProviderIn(provider, noCredentials, { NODE_ENV: 'production' })).toBe(false);
      }
      expect(isMockCloudProviderIn('aws', noCredentials, { NODE_ENV: 'development' })).toBe(true);
    });
  });

  describe('a provider Koala cannot make clusters on yet', () => {
    const production = { NODE_ENV: 'production' };

    it('is AWS, Google Cloud and Azure, whose constructs are stubs; k3d, a machine of the person\'s, Hetzner and DigitalOcean are made for real', () => {
      expect(['k3d', 'remote', 'hetzner', 'do'].every(providerReady)).toBe(true);
      expect(['aws', 'gcp', 'azure'].some(providerReady)).toBe(false);
      expect(providerReady('linode')).toBe(false);
    });

    it('is refused as not available yet, keys or none, except for mock cloud mode on a dev box', () => {
      expect(provisionRefusal('aws', 'user', production)).toBe('Amazon Web Services is not available yet');
      expect(provisionRefusal('gcp', 'mock', production)).toBe('Google Cloud Platform is not available yet');
      expect(provisionRefusal('azure', 'env', {})).toBe('Microsoft Azure is not available yet');
      expect(provisionRefusal('aws', 'user', {})).toBe('Amazon Web Services is not available yet');
      expect(provisionRefusal('aws', 'mock', {})).toBeUndefined();
      for (const provider of ['k3d', 'remote', 'hetzner', 'do']) expect(provisionRefusal(provider, 'user', production), provider).toBeUndefined();
    });

    it('says so on Cloud providers: mock cloud mode only on a dev box, otherwise not yet', () => {
      expect(clusterAvailability('aws', {})).toBe('mock-only');
      expect(clusterAvailability('aws', production)).toBe('not-yet');
      expect(clusterAvailability('hetzner', production)).toBe('available');
      expect(clusterAvailability('huggingface', production)).toBeUndefined();
    });

    it('refuses a provider Koala does not make clusters on, anywhere', () => {
      expect(provisionRefusal('mars', 'user', {})).toBe('mars is not a provider Koala makes clusters on');
    });
  });

  describe('DigitalOcean', () => {
    it('is never mock, with or without credentials', () => {
      expect(isMockCloudProviderIn('do', noCredentials, {})).toBe(false);
      expect(isMockCloudProviderIn('do', hasCredentials, {})).toBe(false);
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
    vllmGpuCount: 0,
    vllmDevice: '',
    hostHfToken: undefined,
    tabbyGpuCount: 0,
    storageEnv: {},
  } satisfies Omit<AppEnvArgs, 'provider' | 'isMock'>;

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
