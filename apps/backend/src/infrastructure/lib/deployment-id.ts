import { createHash } from 'node:crypto';

export function deriveDeploymentId(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 8);
}

export function deploymentIdFor(
  stored: string | undefined,
  identity: string,
): string {
  return stored || deriveDeploymentId(identity);
}
