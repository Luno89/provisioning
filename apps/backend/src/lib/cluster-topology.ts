/**
 * cluster-topology.ts
 *
 * The two provider predicates that decide how the platform talks to a cluster. Both were
 * previously open-coded in ~20 places across services and activities, and both silently acquired
 * a bug every time a new provider was added and one of those copies was missed:
 *
 *  - 'remote' was missing from the mock-cloud exclusion, which made reconciliation treat a real
 *    SSH-bootstrapped host as `mock-remote-<name>`, look for a k3d container that never existed,
 *    conclude the cluster had been deleted, and erase the record (see ClusterService.isMockCloud's
 *    full account of that incident).
 *  - 'hetzner' was then missing from the self-managed check, which gave every app deployed to a
 *    Hetzner VM a `LoadBalancer` Service that hangs forever on single-node k3s, and pointed the
 *    kubeconfig at a path that never exists.
 *
 * Adding a provider should be one edit here, not twenty greps.
 */

/**
 * Providers that always represent a REAL cluster, never a local k3d container standing in for an
 * unconfigured cloud.
 *
 * 'remote'  — an already-existing SSH-reachable machine; there are no credentials to check.
 * 'hetzner' — a VM this platform creates itself. It *does* need credentials, but their absence is
 *             a hard error at provision time, never a silent downgrade to mock mode.
 * 'do'      — same as 'hetzner': a droplet this platform creates. Before it had a provisioning
 *             branch, a 'do' cluster WITH credentials fell through every branch in
 *             ProvisionClusterActivity and then ran the shared CDKTF tail against a kubeconfig
 *             that was never written — a confusing failure rather than an honest one.
 *
 *             MIGRATION NOTE: 'do' used to fall through to mock mode when uncredentialed, so any
 *             cluster created that way is a local k3d container named `mock-do-<name>`. It will no
 *             longer resolve, because getPhysicalClusterName now returns `<name>`. There were no
 *             such records when this changed; if one ever appears, delete and recreate it rather
 *             than expecting reconciliation to cope.
 *
 * Both are excluded because `hasCloudCredentials()` has no case for them and would otherwise
 * resolve to mode 'mock'.
 */
export const NEVER_MOCK_PROVIDERS: readonly string[] = ['k3d', 'remote', 'hetzner', 'do'];

/**
 * Providers whose Kubernetes API this platform reaches through its own kubeconfig at
 * `/tmp/kubeconfig-<physicalName>`, and which have no cloud load-balancer controller — so app
 * Services must be NodePort rather than LoadBalancer.
 *
 * Deliberately the same list as NEVER_MOCK_PROVIDERS: a mock-cloud cluster is a k3d container and
 * qualifies too, which is why callers pass their already-computed `isMock`.
 */
export function isSelfManagedCluster(provider: string, isMock: boolean): boolean {
  return isMock || NEVER_MOCK_PROVIDERS.includes(provider);
}

/**
 * True when this provider has no credentials configured anywhere and should therefore run as a
 * local k3d container instead of hitting a real cloud API.
 *
 * `hasCloudCredentials` is injected rather than imported so this module stays usable from both
 * activities (which use the process-env resolver) and services (which layer user-stored
 * credentials on top).
 */
export function isMockCloudProvider(
  provider: string,
  hasCloudCredentials: (provider: string) => boolean,
): boolean {
  if (NEVER_MOCK_PROVIDERS.includes(provider)) return false;
  return !hasCloudCredentials(provider);
}
