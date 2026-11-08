import type { CloudCredentials } from '../../platform/index.js';
import { credentialsFor, type ResolvedCredentials } from '../lib/credential-resolver.js';

export function resolveCloudCredentials(
  provider: string,
  userCreds: CloudCredentials | undefined,
  asOperator = true,
): ResolvedCredentials {
  return credentialsFor(provider, userCreds, asOperator ? process.env : undefined);
}
