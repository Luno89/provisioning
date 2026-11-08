import type { CloudCredentials } from '../../platform/index.js';
import { credentialsFor, type OperatorEnv, type ResolvedCredentials } from '../lib/credential-resolver.js';

export function resolveCloudCredentials(
  provider: string,
  userCreds: CloudCredentials | undefined,
  operatorEnv: OperatorEnv | undefined,
): ResolvedCredentials {
  return credentialsFor(provider, userCreds, operatorEnv);
}
