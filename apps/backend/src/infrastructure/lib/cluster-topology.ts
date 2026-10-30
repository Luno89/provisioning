type Env = Readonly<Record<string, string | undefined>>;

export const CLUSTER_PROVIDER_NAMES: readonly string[] = ['k3d', 'aws', 'gcp', 'azure', 'do', 'remote', 'hetzner'];

export const NEVER_MOCK_PROVIDERS: readonly string[] = ['k3d', 'remote', 'hetzner', 'do'];

export const CLOUD_LABELS: Readonly<Record<string, string>> = { aws: 'Amazon Web Services', gcp: 'Google Cloud Platform', azure: 'Microsoft Azure' };

export const mockCloudAllowed = (env: Env): boolean => env.NODE_ENV !== 'production';

export const mockableProvider = (provider: string): boolean => CLUSTER_PROVIDER_NAMES.includes(provider) && !NEVER_MOCK_PROVIDERS.includes(provider);

export const addYourKeys = (provider: string): string => `add your ${CLOUD_LABELS[provider] ?? provider} keys under Cloud providers`;

export function withoutKeys(provider: string, env: Env): 'mock' | 'refused' | undefined {
  if (!mockableProvider(provider)) return undefined;
  return mockCloudAllowed(env) ? 'mock' : 'refused';
}

export class ProvisionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionRefused';
  }
}

export function provisionRefusal(provider: string, credentials: 'user' | 'env' | 'mock', env: Env): string | undefined {
  if (!CLUSTER_PROVIDER_NAMES.includes(provider)) return `${provider} is not a provider Koala makes clusters on`;
  if (credentials !== 'mock' || withoutKeys(provider, env) !== 'refused') return undefined;
  return `Koala has no ${CLOUD_LABELS[provider]} keys of yours to make this cluster with: ${addYourKeys(provider)}`;
}

export function isSelfManagedCluster(provider: string, isMock: boolean): boolean {
  return isMock || NEVER_MOCK_PROVIDERS.includes(provider);
}

export function isMockCloudProvider(
  provider: string,
  hasCloudCredentials: (provider: string) => boolean,
  env: Env = process.env,
): boolean {
  if (NEVER_MOCK_PROVIDERS.includes(provider) || !mockCloudAllowed(env)) return false;
  return !hasCloudCredentials(provider);
}
