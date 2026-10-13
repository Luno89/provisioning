import { namespaceOfDeployment } from './mcp-registry.js';
import type { ServerRuns } from './mcp-servers.js';
import type { DeploymentMetadata } from './types.js';

export function hostedMcpUrl(deps: {
  deployments: () => Promise<readonly Pick<DeploymentMetadata, 'id' | 'name' | 'ownerId' | 'status'>[]>;
  probeUrl: (namespace: string) => Promise<string | undefined>;
}): (ownerId: string, runs: Extract<ServerRuns, { where: 'hosted' }>) => Promise<string | undefined> {
  return async (ownerId, runs) => {
    if ('url' in runs) return runs.url;
    const deployment = (await deps.deployments()).find((entry) => entry.id === runs.deploymentId && entry.ownerId === ownerId);
    if (!deployment || deployment.status !== 'running') return undefined;
    return deps.probeUrl(namespaceOfDeployment(deployment));
  };
}
