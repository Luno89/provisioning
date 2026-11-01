import type { CloudCredentials } from '../../platform/index.js';
import { isMockCloudProviderIn } from '../lib/cluster-topology.js';
import { credentialsFor, hasCredentialsIn, type ResolvedCredentials } from '../lib/credential-resolver.js';

export function resolveCloudCredentials(
  provider: string,
  userCreds: CloudCredentials | undefined,
  asOperator = true,
): ResolvedCredentials {
  return credentialsFor(provider, userCreds, asOperator ? process.env : undefined);
}

export function hasCloudCredentials(provider: string, userCreds?: CloudCredentials): boolean {
  return hasCredentialsIn(provider, process.env, userCreds);
}

export function isMockCloudProvider(provider: string, hasCredentials: (provider: string) => boolean): boolean {
  return isMockCloudProviderIn(provider, hasCredentials, process.env);
}
