import { McpClient, type McpTool } from '../lib/mcp-client.js';
import { looksLikeMcp, mcpUrlFor, namespaceOfDeployment, type McpServer } from '../lib/mcp-registry.js';
import type { Database } from '../lib/db-interface.js';
import { serviceNameFor, usableServiceName } from '../lib/service-name.js';

export class McpRegistryService {
  private cache = new Map<string, { tools: McpTool[]; at: number; error?: string }>();

  constructor(
    private readonly db: Database,
    private readonly ownerId: string,
    private readonly probeUrlFor: (deploymentName: string) => Promise<string | undefined>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 10 * 60 * 1000,
  ) {}

  async list(): Promise<McpServer[]> {
    const deployments = (await this.db.getDeployments())
      .filter((d) => d.ownerId === this.ownerId)
      .filter(looksLikeMcp);
    const [allProjects, allTrees] = await Promise.all([this.db.getProjects(), this.db.getTrees()]);
    const projects = allProjects.filter((p) => p.ownerId === this.ownerId);
    const trees = allTrees.filter((t) => t.ownerId === this.ownerId);
    const nameOf = (dep: { name: string; gitappProjectId?: string }) => {
      const project = projects.find((p) => p.id === dep.gitappProjectId);
      const tree = project ? trees.find((t) => (t.projectIds ?? []).includes(project.id)) : undefined;
      return serviceNameFor({
        ...(usableServiceName((tree as { serviceName?: unknown } | undefined)?.serviceName)
          ? { declared: usableServiceName((tree as { serviceName?: unknown }).serviceName) }
          : {}),
        ...(tree?.name ? { treeName: tree.name } : {}),
        ...(project?.name ? { projectName: project.name } : {}),
        deploymentName: dep.name,
      });
    };
    const live = new Set(deployments.map((d) => d.id));
    for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);

    return Promise.all(deployments.map(async (dep) => {
      const known = this.cache.get(dep.id);
      return {
        id: dep.id,
        name: nameOf(dep as never),
        deploymentName: dep.name,
        url: mcpUrlFor(dep, namespaceOfDeployment(dep)),
        probeUrl: await this.probeUrlFor(namespaceOfDeployment(dep)),
        ...(dep.gitappProjectId ? { projectId: dep.gitappProjectId } : {}),
        tools: known?.tools ?? [],
        ...(known ? { lastSeen: new Date(known.at).toISOString() } : {}),
        ...(known?.error ? { unreachable: known.error } : {}),
      };
    }));
  }

  async introspect(server: McpServer, force = false): Promise<McpServer> {
    const known = this.cache.get(server.id);
    if (!force && known && Date.now() - known.at < this.ttlMs && !known.error) {
      return { ...server, tools: known.tools, lastSeen: new Date(known.at).toISOString() };
    }

    if (!server.probeUrl) {
      const error = 'No NodePort resolved for this deployment, so the backend has no route to it.';
      this.cache.set(server.id, { tools: [], at: Date.now(), error });
      return { ...server, tools: [], unreachable: error, lastSeen: new Date().toISOString() };
    }

    try {
      const client = new McpClient(server.probeUrl, this.fetchImpl);
      const tools = await client.listTools();
      this.cache.set(server.id, { tools, at: Date.now() });
      return { ...server, tools, lastSeen: new Date().toISOString() };
    } catch (err: any) {
      const error = String(err?.message ?? err).slice(0, 200);
      this.cache.set(server.id, { tools: [], at: Date.now(), error });
      return { ...server, tools: [], unreachable: error, lastSeen: new Date().toISOString() };
    }
  }

  async listWithTools(force = false): Promise<McpServer[]> {
    const servers = await this.list();
    return Promise.all(servers.map((s) => this.introspect(s, force)));
  }

  async call(server: McpServer, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const client = new McpClient(server.probeUrl ?? server.url, this.fetchImpl);
    try {
      return await client.callTool(tool, args);
    } catch (err: any) {
      return { text: `Could not reach ${server.name}: ${String(err?.message ?? err).slice(0, 200)}`, isError: true };
    }
  }
}
