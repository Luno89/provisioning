import type { ClusterMetadata, DeploymentMetadata } from '../../platform/index.js';
import { namespaceOf, type ClusterAccess } from '../../infrastructure/index.js';
import { McpClient } from '../lib/mcp-client.js';
import { GITAPP_SERVICE, mcpProbeUrlOf, type McpServiceSpec } from '../lib/mcp-registry.js';
import type { McpProbe } from '../lib/mcp-probe-url.js';

export type McpDeployment = Pick<DeploymentMetadata, 'id' | 'name' | 'namespace' | 'clusterId'>;

export interface McpReachDeps {
  access: Pick<ClusterAccess, 'reach' | 'kubectl'>;
  clusterById: (id: string) => Promise<Pick<ClusterMetadata, 'meshIp'> | undefined>;
  fetch?: typeof fetch | undefined;
}

export interface McpReach {
  url(deployment: McpDeployment): Promise<string>;
  probe(deployment: McpDeployment): Promise<McpProbe>;
}

export function mcpReachFrom(deps: McpReachDeps): McpReach {
  const url = async (deployment: McpDeployment): Promise<string> => {
    const namespace = namespaceOf(deployment);
    const reach = await deps.access.reach(deployment.clusterId);
    if (reach.kind === 'root') throw new Error(`${deployment.clusterId} is root's own cluster, which runs no one's MCP server`);
    const service = JSON.parse(await deps.access.kubectl(reach, ['get', 'svc', GITAPP_SERVICE, '-n', namespace, '-o', 'json'])) as McpServiceSpec;
    if (reach.kind === 'koala') return mcpProbeUrlOf(service, namespace, { kind: 'koala' });
    return mcpProbeUrlOf(service, namespace, { kind: 'machine', clusterId: reach.clusterId, meshIp: (await deps.clusterById(reach.clusterId))?.meshIp });
  };
  return {
    url,
    probe: async (deployment) => {
      try {
        return { tools: (await new McpClient(await url(deployment), deps.fetch ?? fetch).listTools()).length };
      } catch (err) {
        return { unreachable: String((err as Error)?.message ?? err).slice(0, 200), tools: 0 };
      }
    },
  };
}
