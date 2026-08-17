/**
 * Which MCP servers exist, what they can do, and who is allowed to use them.
 *
 * ── THE GAP THIS CLOSES ──
 * Koala can build an MCP server and deploy it, and then has no idea it exists. The pod runs, the
 * tools are there, and the next thing Koala builds cannot call the thing it built last week. For a
 * harness whose whole point is adding capability to itself, that is the loop left open.
 *
 * ── DERIVED FROM DEPLOYMENTS, NOT A SECOND SOURCE OF TRUTH ──
 * A server IS a deployment. Keeping a separate list of them would drift the moment one was
 * destroyed, and a registry that offers tools from a pod that no longer exists is worse than no
 * registry — the agent would call it, wait for the timeout, and report a mystery.
 *
 * What is stored is only what cannot be derived: the tools a server reported when last asked, so
 * offering them costs nothing per run.
 *
 * ── SCOPING ──
 * A persona opts in by name. Two reasons it is not automatic: every tool offered costs prompt
 * tokens on every single turn, and reaching a server is also a NETWORK decision — the sandbox's
 * egress has to allow it, and a capability the policy forbids is a tool that fails confusingly
 * rather than one that is absent. `mcpGaps` reports exactly that disagreement.
 */
import type { DeploymentMetadata } from './types.js';
import type { McpTool } from './mcp-client.js';

/**
 * The Service a Koala-built app is deployed behind.
 *
 * Always `gitapp`, never the deployment's own name — the deployment is called
 * `koala-request-42784df9` and its Service is `gitapp` in a namespace of that name. Building the
 * URL from the deployment name gave `koala-request-42784df9.koala-request-koala-request-42784df9`,
 * which resolves to nothing.
 */
export const GITAPP_SERVICE = 'gitapp';

/** The namespace a request's app runs in — the deployment's name IS the namespace. */
export function namespaceOfDeployment(dep: Pick<DeploymentMetadata, 'name'>): string {
  return dep.name;
}

/**
 * Where a POD reaches this server.
 *
 * The in-cluster Service address. This is the one handed to a sandbox, because pod-to-pod must not
 * depend on an ingress controller being up or a hostname resolving outside the cluster.
 */
export function mcpUrlFor(dep: Pick<DeploymentMetadata, 'name'>, namespace = namespaceOfDeployment(dep), port = 8080): string {
  return `http://${GITAPP_SERVICE}.${namespace}.svc.cluster.local:${port}/mcp`;
}

/**
 * Where the BACKEND reaches this server.
 *
 * Deliberately a different address, and the distinction is load-bearing: the backend runs on the
 * host and cannot resolve `*.svc.cluster.local` at all, so introspecting through the in-cluster URL
 * fails with a bare "fetch failed" that looks exactly like a dead server. The Service is a NodePort,
 * so the node's own address works from the host.
 */
export function mcpProbeUrlFor(nodeIp: string, nodePort: number): string {
  return `http://${nodeIp}:${nodePort}/mcp`;
}

export interface McpServer {
  /** The deployment's id — the registry has no identity of its own. */
  id: string;
  /** What the model sees and what its tools are prefixed with — resolved, not the deployment's. */
  name: string;
  /** The Kubernetes identity. What addresses, namespaces and logs use. */
  deploymentName?: string;
  /** What a SANDBOX uses. In-cluster, and unusable from the backend. */
  url: string;
  /** What the BACKEND uses to introspect. Absent when the NodePort could not be resolved. */
  probeUrl?: string | undefined;
  /** What it reported last time it was asked, and when. */
  tools: McpTool[];
  lastSeen?: string;
  /** Why it is unusable, when it is. */
  unreachable?: string;
  /**
   * The project whose repository builds this server, when it has one.
   *
   * What makes a running server EDITABLE: a leaf pointed at this project checks out the repo the
   * server is built from, so adding a tool is a change to what exists rather than a second server.
   */
  projectId?: string;
}

/** A deployment is a candidate if it is running and speaks MCP. */
export function looksLikeMcp(dep: Pick<DeploymentMetadata, 'status' | 'appType'>): boolean {
  // `gitapp` is what a Koala-built service deploys as. A destroyed or deploying pod is not a
  // server: offering its tools would have the agent call something that is not there.
  return dep.status === 'running' && dep.appType === 'gitapp';
}

/**
 * The servers a persona may use, and the ones it asked for and cannot have.
 *
 * Returned together on purpose. A persona that names a server which is not running should not
 * silently get a smaller toolset — that is a configuration mistake, and the run will fail later for
 * a reason nothing on screen explains.
 */
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

/**
 * Where a persona's capabilities and its network policy disagree.
 *
 * A tool it can see and cannot reach is the worst of both: the model spends turns calling something
 * that times out, and the reason — a NetworkPolicy three layers away — appears nowhere near the
 * failure. Reporting it up front turns a baffling run into a configuration error.
 */
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

/**
 * How the servers are described to the model.
 *
 * Named rather than merely offered: a model given eleven tools with no idea where they came from
 * cannot reason about which SERVICE to use for a job, only which function. Saying "these came from
 * a thing you built" is what makes reuse a choice rather than an accident.
 */
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


/**
 * One entry per NAME, preferring the copy that answers.
 *
 * Two deployments can carry one service name — observed the moment a second run redeployed
 * `github-mcp`, leaving one copy with three tools and one returning `HTTP 404 from initialize`.
 * Anything keyed by name downstream then picks whichever sorted last, which was the broken one.
 *
 * This is a presentation rule, not a repair: a stale deployment under a live name is a real problem
 * and still shows up in the raw listing. It just should not be the copy a person is offered or an
 * agent calls.
 */
export function preferUsable(servers: readonly McpServer[]): McpServer[] {
  const out = new Map<string, McpServer>();
  for (const s of servers) {
    const held = out.get(s.name);
    const better = !held || (!s.unreachable && s.tools.length && (held.unreachable || !held.tools.length));
    if (better) out.set(s.name, s);
  }
  return [...out.values()];
}
