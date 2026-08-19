/**
 * The address a pod uses to reach a Service.
 *
 * ── WHY THIS IS ONE FUNCTION AND NOT THREE ──
 * Kubernetes gives every Service a DNS record at `<service>.<namespace>.svc.cluster.local`. That is
 * the standard, it works across namespaces, and it is the only discovery mechanism worth using —
 * Kubernetes also injects `<NAME>_SERVICE_HOST` environment variables, but those are Docker-link
 * legacy: same-namespace only, and only for Services that existed BEFORE the pod started.
 *
 * This codebase built that string in three places by hand — `app-env.ts` for minio,
 * `mcp-registry.ts` for MCP servers, `llm-apps.ts` for inference servers. Each was one line and
 * each was slightly different. That is survivable while three callers each own their own answer,
 * and stops being survivable the moment a fourth caller has to produce the SAME answer as an
 * existing one: a service binding tells an app where to connect, and if the address it is given
 * differs by a character from the address the Service actually has, the app reaches nothing and the
 * error is a DNS failure three layers from the cause.
 *
 * ── WHAT THIS DOES NOT DECIDE ──
 * What a Service is CALLED. `minio` is `minio`, an MCP server's is `gitapp`, and an LLM app's is
 * `<namespace>-<suffix>`. Those are facts about how each app deploys, not inconsistencies to
 * unify — so they stay with the callers that know them, and only the address construction is
 * shared.
 */

/** The cluster's DNS domain. Configurable in Kubernetes; `cluster.local` is the default and ours. */
const CLUSTER_DOMAIN = 'svc.cluster.local';

export interface ClusterAddress {
  /** The Service's name, which is not always the app's name. */
  service: string;
  namespace: string;
  port: number;
}

/**
 * The fully-qualified DNS name of a Service.
 *
 * Fully qualified rather than the `<service>.<namespace>` short form: the short form resolves only
 * through the pod's search domains, which differ between a pod, a sandbox and anything running with
 * a custom `dnsConfig`. The long form means the same thing everywhere.
 */
export function clusterHost(service: string, namespace: string): string {
  return `${service}.${namespace}.${CLUSTER_DOMAIN}`;
}

/** `host:port`, for a client that wants the two joined but no scheme. */
export function clusterAuthority(address: ClusterAddress): string {
  return `${clusterHost(address.service, address.namespace)}:${address.port}`;
}

/**
 * A full URL for a Service.
 *
 * `scheme` defaults to http because this is pod-to-pod inside one cluster, where TLS would need
 * certificates nothing here issues. `path` is appended as given — a caller that wants `/mcp` knows
 * it wants `/mcp`, and this should not guess at one.
 */
export function clusterUrl(
  address: ClusterAddress,
  opts: { scheme?: string; path?: string } = {},
): string {
  const { scheme = 'http', path = '' } = opts;
  return `${scheme}://${clusterAuthority(address)}${path}`;
}
