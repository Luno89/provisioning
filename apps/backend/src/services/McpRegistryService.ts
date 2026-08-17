import { McpClient, type McpTool } from '../lib/mcp-client.js';
import { looksLikeMcp, mcpUrlFor, namespaceOfDeployment, type McpServer } from '../lib/mcp-registry.js';
import type { Database } from '../lib/db-interface.js';
import { serviceNameFor, usableServiceName } from '../lib/service-name.js';

/**
 * Finding the MCP servers Koala has deployed, and asking them what they can do.
 *
 * ── WHY IT IS A CACHE OVER DEPLOYMENTS, NOT A TABLE ──
 * A server IS a deployment. A separate table would drift the moment one was destroyed, and offering
 * tools from a pod that no longer exists is worse than offering none: the agent calls it, waits for
 * the timeout, and reports a mystery unrelated to its task.
 *
 * So the LIST is always derived, and only the introspection result is remembered — with the time it
 * was taken, because a stale answer presented as current is the same failure in slow motion.
 *
 * ── SCOPED TO ONE OWNER ──
 * Every lookup is filtered by `ownerId`. A registry that reads every deployment offers one tenant's
 * agent the tools of another tenant's service — and `mcpUrlFor` hands it the in-cluster address to
 * call them with. That is cross-tenant access dressed up as a feature, and it is the kind of thing
 * that is invisible on a single-user instance right up until it is not.
 *
 * ── EVERY PROBE IS BEST-EFFORT ──
 * A server that is deploying, wedged, or not actually MCP must not take down the caller. A registry
 * that throws when one of eleven servers is unhealthy is a registry nobody can use.
 */
export class McpRegistryService {
  /** Keyed by deployment id. Cleared for anything that stops running. */
  private cache = new Map<string, { tools: McpTool[]; at: number; error?: string }>();

  constructor(
    private readonly db: Database,
    /** Whose deployments this registry may see. Never optional — see the header. */
    private readonly ownerId: string,
    /**
     * How the BACKEND reaches a given deployment, which is not how a sandbox reaches it.
     *
     * The backend runs on the host and cannot resolve `*.svc.cluster.local` at all — introspecting
     * through the in-cluster URL fails with a bare "fetch failed" that reads exactly like a dead
     * server. Resolved by the caller because it means asking Kubernetes for a NodePort.
     */
    private readonly probeUrlFor: (deploymentName: string) => Promise<string | undefined>,
    private readonly fetchImpl: typeof fetch = fetch,
    /** How long an introspection stays fresh. A server's tools change only when it is redeployed. */
    private readonly ttlMs = 10 * 60 * 1000,
  ) {}

  /** Running deployments that could be MCP servers, with whatever is known about their tools. */
  async list(): Promise<McpServer[]> {
    const deployments = (await this.db.getDeployments())
      .filter((d) => d.ownerId === this.ownerId)
      .filter(looksLikeMcp);
    /**
     * The NAME a service is offered under, which is not its deployment's name.
     *
     * A deployment is called `koala-request-42784df9`, and so is its project — so every tool it
     * exposed was prefixed with a hex id while the tree had been called "Weather API MCP" the whole
     * time. Resolved rather than renamed: renaming the deployment would mean renaming its
     * namespace, Service and DNS, orphaning everything running.
     */
    // Scoped too: a name resolved through somebody else's tree would leak what they called it.
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
    // Anything that stopped running loses its cached tools rather than lingering as an offer.
    for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);

    return Promise.all(deployments.map(async (dep) => {
      const known = this.cache.get(dep.id);
      return {
        id: dep.id,
        // What the model sees, and what its tools are prefixed with.
        name: nameOf(dep as never),
        /** The Kubernetes identity, kept because that is what addresses and logs use. */
        deploymentName: dep.name,
        url: mcpUrlFor(dep, namespaceOfDeployment(dep)),
        probeUrl: await this.probeUrlFor(dep.name),
        tools: known?.tools ?? [],
        ...(known ? { lastSeen: new Date(known.at).toISOString() } : {}),
        ...(known?.error ? { unreachable: known.error } : {}),
      };
    }));
  }

  /**
   * Asks a server what it can do, unless a recent answer is already held.
   *
   * Returns the server either way: a failed probe is recorded ON the server as `unreachable` rather
   * than thrown, so one wedged pod cannot stop the other ten being offered.
   */
  async introspect(server: McpServer, force = false): Promise<McpServer> {
    const known = this.cache.get(server.id);
    if (!force && known && Date.now() - known.at < this.ttlMs && !known.error) {
      return { ...server, tools: known.tools, lastSeen: new Date(known.at).toISOString() };
    }

    if (!server.probeUrl) {
      // Said plainly rather than attempted: without a NodePort the backend has no route at all, and
      // "fetch failed" would blame the server for the harness's own missing address.
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
      // Kept with an empty tool list: "we asked and it did not answer" is a different fact from
      // "we never asked", and the UI should be able to tell them apart.
      this.cache.set(server.id, { tools: [], at: Date.now(), error });
      return { ...server, tools: [], unreachable: error, lastSeen: new Date().toISOString() };
    }
  }

  /** Every server, each asked what it can do. Probed in parallel — they are independent. */
  async listWithTools(force = false): Promise<McpServer[]> {
    const servers = await this.list();
    return Promise.all(servers.map((s) => this.introspect(s, force)));
  }

  /** Runs one tool on one server. */
  async call(server: McpServer, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    // The backend's address, for the same reason introspection uses it.
    const client = new McpClient(server.probeUrl ?? server.url, this.fetchImpl);
    try {
      return await client.callTool(tool, args);
    } catch (err: any) {
      // Returned, not thrown: a tool that fails is information the agent can act on, and killing
      // the run over it would discard everything done so far.
      return { text: `Could not reach ${server.name}: ${String(err?.message ?? err).slice(0, 200)}`, isError: true };
    }
  }
}
