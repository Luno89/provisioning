import type { DeploymentMetadata } from '../../platform/index.js';
import { clusterUrl } from '../../infrastructure/lib/cluster-dns.js';
import type { McpTool } from './mcp-client.js';
import { namespaceOf } from '../../infrastructure/lib/app-namespace.js';

export const GITAPP_SERVICE = 'gitapp';

export function namespaceOfDeployment(dep: Pick<DeploymentMetadata, 'name' | 'namespace'>): string {
  return namespaceOf(dep);
}

export function mcpUrlFor(dep: Pick<DeploymentMetadata, 'name' | 'namespace'>, namespace = namespaceOfDeployment(dep), port = 8080): string {
  return clusterUrl({ service: GITAPP_SERVICE, namespace, port }, { path: '/mcp' });
}

export interface McpServiceSpec {
  spec?: { ports?: { name?: string; port: number; nodePort?: number }[] } | undefined;
}

export type McpCluster = { kind: 'koala' } | { kind: 'machine'; clusterId: string; meshIp?: string | undefined };

export function mcpProbeUrlOf(service: McpServiceSpec, namespace: string, cluster: McpCluster): string {
  const port = service.spec?.ports?.[0];
  if (!port) throw new Error(`the MCP server in ${namespace} serves no port`);
  if (cluster.kind === 'koala') return clusterUrl({ service: GITAPP_SERVICE, namespace, port: port.port }, { path: '/mcp' });
  if (!cluster.meshIp) throw new Error(`${cluster.clusterId} has no mesh address, so Koala cannot reach the MCP server on it`);
  if (!port.nodePort) throw new Error(`the MCP server in ${namespace} on ${cluster.clusterId} has no node port, so Koala cannot reach it from its own cluster`);
  return `http://${cluster.meshIp}:${port.nodePort}/mcp`;
}

export interface McpServer {
  id: string;
  name: string;
  deploymentName?: string;
  url: string;
  probeUrl?: string | undefined;
  tools: McpTool[];
  lastSeen?: string;
  unreachable?: string;
  projectId?: string;
}

export function looksLikeMcp(dep: Pick<DeploymentMetadata, 'status' | 'appType'>): boolean {
  return dep.status === 'running' && dep.appType === 'gitapp';
}

export function resolveForPersona(
  wanted: string[] | undefined,
  available: McpServer[],
): { servers: McpServer[]; missing: string[] } {
  if (!wanted?.length) return { servers: [], missing: [] };
  const servers = available.filter((s) => wanted.includes(s.name));
  const missing = wanted.filter((w) => !available.some((s) => s.name === w));
  return { servers, missing };
}

export interface EgressRule { namespace?: string; cidr?: string; ports?: number[] }

export function mcpGaps(
  servers: McpServer[],
  egress: EgressRule[] | undefined,
  namespaceOf: (server: McpServer) => string,
): string[] {
  const allowed = new Set((egress ?? []).map((e) => e.namespace).filter(Boolean) as string[]);
  return servers
    .filter((s) => !allowed.has(namespaceOf(s)))
    .map((s) => `${s.name} is offered but its namespace (${namespaceOf(s)}) is not in this persona's egress —`
      + ' the tool would be visible and every call would time out.');
}

export function describeServers(servers: McpServer[]): string {
  if (!servers.length) return '';
  return [
    'Services you can call, built and deployed by this harness:',
    ...servers.map((s) => {
      const names = s.tools.map((t) => t.name).join(', ') || 'no tools reported';
      return `- ${s.name}: ${names}`;
    }),
    '',
    'Their tools are prefixed with the service name. Prefer calling one of these over rebuilding'
      + ' what it already does.',
  ].join('\n');
}

export function preferUsable(servers: readonly McpServer[]): McpServer[] {
  const out = new Map<string, McpServer>();
  for (const s of servers) {
    const held = out.get(s.name);
    const better = !held || (!s.unreachable && s.tools.length && (held.unreachable || !held.tools.length));
    if (better) out.set(s.name, s);
  }
  return [...out.values()];
}
