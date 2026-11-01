type Env = Readonly<Record<string, string | undefined>>;

export const CLUSTER_PROVIDER_NAMES: readonly string[] = ['k3d', 'aws', 'gcp', 'azure', 'do', 'remote', 'hetzner'];

export const NEVER_MOCK_PROVIDERS: readonly string[] = ['k3d', 'remote', 'hetzner', 'do'];

export type ClusterBuild = 'here' | 'over-ssh' | 'vm-then-ssh' | 'not-yet';

export const CLUSTER_BUILDS: Readonly<Record<string, ClusterBuild>> = {
  k3d: 'here',
  remote: 'over-ssh',
  hetzner: 'vm-then-ssh',
  do: 'vm-then-ssh',
  aws: 'not-yet',
  gcp: 'not-yet',
  azure: 'not-yet',
};

export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  k3d: 'Local Datacenter (k3d)', remote: 'One of my machines', hetzner: 'Hetzner Cloud', do: 'DigitalOcean',
  aws: 'Amazon Web Services', gcp: 'Google Cloud Platform', azure: 'Microsoft Azure',
};

export const providerReady = (provider: string): boolean => CLUSTER_PROVIDER_NAMES.includes(provider) && CLUSTER_BUILDS[provider] !== 'not-yet';

export const notAvailableYet = (provider: string): string => `${PROVIDER_LABELS[provider] ?? provider} is not available yet`;

export const mockCloudAllowed = (env: Env): boolean => env.NODE_ENV !== 'production';

export const mockableProvider = (provider: string): boolean => CLUSTER_PROVIDER_NAMES.includes(provider) && !NEVER_MOCK_PROVIDERS.includes(provider);

export function clusterAvailability(provider: string, env: Env): 'available' | 'mock-only' | 'not-yet' | undefined {
  if (!CLUSTER_PROVIDER_NAMES.includes(provider)) return undefined;
  if (providerReady(provider)) return 'available';
  return mockableProvider(provider) && mockCloudAllowed(env) ? 'mock-only' : 'not-yet';
}

export class ProvisionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionRefused';
  }
}

export function provisionRefusal(provider: string, credentials: 'user' | 'env' | 'mock', env: Env): string | undefined {
  if (!CLUSTER_PROVIDER_NAMES.includes(provider)) return `${provider} is not a provider Koala makes clusters on`;
  if (providerReady(provider)) return undefined;
  if (credentials === 'mock' && mockableProvider(provider) && mockCloudAllowed(env)) return undefined;
  return notAvailableYet(provider);
}

export function isSelfManagedCluster(provider: string, isMock: boolean): boolean {
  return isMock || NEVER_MOCK_PROVIDERS.includes(provider);
}

export function isMockCloudProviderIn(
  provider: string,
  hasCloudCredentials: (provider: string) => boolean,
  env: Env,
): boolean {
  if (NEVER_MOCK_PROVIDERS.includes(provider) || !mockCloudAllowed(env)) return false;
  return !hasCloudCredentials(provider);
}
