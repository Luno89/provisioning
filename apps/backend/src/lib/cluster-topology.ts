
export const NEVER_MOCK_PROVIDERS: readonly string[] = ['k3d', 'remote', 'hetzner', 'do'];

export function isSelfManagedCluster(provider: string, isMock: boolean): boolean {
  return isMock || NEVER_MOCK_PROVIDERS.includes(provider);
}

export function isMockCloudProvider(
  provider: string,
  hasCloudCredentials: (provider: string) => boolean,
): boolean {
  if (NEVER_MOCK_PROVIDERS.includes(provider)) return false;
  return !hasCloudCredentials(provider);
}
