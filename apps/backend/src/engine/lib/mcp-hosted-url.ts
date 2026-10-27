import { namespaceOfDeployment } from './mcp-registry.js';
import type { ServerRuns } from './mcp-servers.js';
import type { DeploymentMetadata } from '../../platform/index.js';

export function hostedMcpUrl(deps: {
  deployments: () => Promise<readonly Pick<DeploymentMetadata, 'id' | 'name' | 'namespace' | 'ownerId' | 'status'>[]>;
  probeUrl: (namespace: string) => Promise<string | undefined>;
  urlProblem?: ((url: string) => Promise<string | undefined>) | undefined;
}): (ownerId: string, runs: Extract<ServerRuns, { where: 'hosted' }>) => Promise<string | undefined> {
  return async (ownerId, runs) => {
    if ('url' in runs) {
      const outside = await deps.urlProblem?.(runs.url);
      if (outside) throw new Error(`Koala reaches a hosted MCP server only on the open internet, and not this one: ${outside}`);
      return runs.url;
    }
    const deployment = (await deps.deployments()).find((entry) => entry.id === runs.deploymentId && entry.ownerId === ownerId);
    if (!deployment || deployment.status !== 'running') return undefined;
    return deps.probeUrl(namespaceOfDeployment(deployment));
  };
}
