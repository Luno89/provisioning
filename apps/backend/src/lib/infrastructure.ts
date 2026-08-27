import { APP_TYPES, APP_FACTS, type AppType } from './app-catalog.js';
import { clusterAuthority } from './cluster-dns.js';
import { bindingTypeFor } from './service-binding.js';

/**
 * What is actually running, and what could be, so Koala stops agreeing to build the impossible.
 *
 * ── THE GAP THIS CLOSES ──
 * Asked to add caching in MongoDB to the GitHub MCP server, Koala planned it. There is no MongoDB.
 * `mongo` is not in APP_TYPES, so the platform cannot deploy one, and the instance's own Mongo runs
 * under docker-compose — not in the cluster, not reachable by a deployed app, and not something to
 * point a built service at.
 *
 * Koala had no way to know any of that. `list_mcp_servers` shows only `gitapp` deployments that
 * speak MCP, so the eight other services actually running — qdrant, minio, quickwit, tei, searxng,
 * crawl4ai, verdaccio, tabbyapi — were invisible too. It could neither use what was there nor say
 * that what was asked for was not.
 *
 * A request the platform cannot satisfy should be refused in conversation, where it costs a
 * sentence, rather than in a build, where it costs a run.
 *
 * ── WHY NO CONNECTION STRINGS ──
 * Reporting a plausible-looking address would be worse than reporting none. Every service here is
 * addressed differently — `llm-apps.ts` builds one shape, the web tools another — and a URL this
 * module invented would be indistinguishable to a model from one it had been told. The name and
 * namespace are facts; the address is the deploy path's business.
 */

export interface RunningService {
  name: string;
  type: string;
  /** What it is, in plain words. A type id alone is not something to reason from. */
  is?: string;
  provides?: string[];
  namespace: string;
  /**
   * Where a pod reaches it, when that is KNOWN.
   *
   * Absent rather than guessed. A spec-deployed app's Service name and port come from the spec that
   * created it, so the address is a fact; for an app built by a hand-written construct there is no
   * general answer, and a plausible-looking address is worse than none — it is indistinguishable to
   * a model from one it was told, and sends work at a host that does not resolve.
   */
  address?: string;
  /** The Service Binding `type`, when this is a backing service something could bind to. */
  bindingType?: string;
}

export interface Infrastructure {
  running: RunningService[];
  /**
   * Deployed and NOT working, with why.
   *
   * ── WHY THIS IS ITS OWN LIST ──
   * The first spec Koala wrote deployed and crash-looped: it set `--noauth` alongside root
   * credentials, and Mongo refuses to start with both. No generic validator catches that — it is
   * one app's flag semantics, and encoding every app's would be writing the fifteen constructs
   * again in another form.
   *
   * So the answer is not more validation, it is a feedback loop. Koala proposed a spec, it failed,
   * and nothing told Koala. The reconciliation loop already knows — it probes and writes
   * `healthReason` — and this is what carries that back to the thing that can fix the spec.
   */
  broken: { name: string; type: string; reason: string }[];
  /**
   * Everything this platform knows how to deploy, with what each one IS.
   *
   * Ids alone were unreadable: nothing said `qdrant` is a vector database or `tei` an embedding
   * server, so a model could neither pick the right one nor tell that what it wanted was absent.
   */
  deployable: { id: AppType; is: string; provides: string[] }[];
}

interface DeploymentLike {
  name: string;
  appType?: string | undefined;
  status?: string | undefined;
  ownerId?: string | undefined;
  /** Why it is unhealthy, written by the reconciliation loop's probe. */
  healthReason?: string | undefined;
}

/** Cluster-level platform infrastructure services exposed to administrators and escalated sessions. */
export const CLUSTER_PLATFORM_SERVICES: readonly RunningService[] = [
  {
    name: 'prometheus',
    type: 'prometheus',
    is: 'cluster metrics database and alerting engine',
    provides: ['PromQL query endpoint and telemetry metrics'],
    namespace: 'monitoring',
    address: 'http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090',
  },
  {
    name: 'grafana',
    type: 'grafana',
    is: 'cluster metrics and logs visualization dashboard',
    provides: ['Grafana UI and visual observability dashboards'],
    namespace: 'monitoring',
    address: 'http://kube-prometheus-stack-grafana.monitoring.svc.cluster.local:80',
  },
  {
    name: 'loki',
    type: 'loki',
    is: 'log aggregation engine',
    provides: ['LogQL query endpoint for cluster and container logs'],
    namespace: 'monitoring',
    address: 'http://loki.monitoring.svc.cluster.local:3100',
  },
  {
    name: 'alertmanager',
    type: 'alertmanager',
    is: 'cluster alert routing and notification manager',
    provides: ['Alert dispatch and webhook notifications'],
    namespace: 'monitoring',
    address: 'http://alertmanager-kube-prometheus-stack-alertmanager.monitoring.svc.cluster.local:9093',
  },
  {
    name: 'gitea',
    type: 'gitea',
    is: 'self-hosted git server and container registry',
    provides: ['Git repositories, code hosting, and container registry'],
    namespace: 'gitea',
    address: 'http://gitea-http.gitea.svc.cluster.local:3000',
  },
  {
    name: 'infisical',
    type: 'infisical',
    is: 'secret and token management vault (AES-256-GCM encrypted, Kubernetes operator synced)',
    provides: ['Secret vault, API tokens, credentials management, pod secret injection'],
    namespace: 'infisical',
    address: 'http://infisical-standalone.infisical.svc.cluster.local:8080',
  },
];

/**
 * The services a build could actually reach, and the catalogue it could add to.
 *
 * Only `running`: a deployment that is `deploying`, `failed` or `destroying` is not something to
 * plan against, and offering one would have a leaf written to connect to an address that answers
 * nothing.
 */
export function describeInfrastructure(
  deployments: readonly DeploymentLike[],
  ownerId: string,
  /**
   * The app-spec catalogue, for resolving addresses.
   *
   * Optional: without it every service still reports its name, type and namespace, just no address.
   * That is the honest degradation — fewer facts, never invented ones.
   */
  specs: readonly { id: string; spec: { ports?: { port: number }[] } }[] = [],
  options?: { isAdmin?: boolean | undefined; isEscalated?: boolean | undefined } | undefined,
): Infrastructure {
  const byType = new Map(specs.map((s) => [s.id, s.spec]));
  const userServices = deployments
    .filter((d) => d.ownerId === ownerId && d.status === 'running')
    .map((d) => ({
      name: d.name,
      type: d.appType ?? 'unknown',
      ...(d.appType && d.appType in APP_FACTS
        ? {
            is: APP_FACTS[d.appType as AppType].is,
            provides: APP_FACTS[d.appType as AppType].provides,
          }
        : {}),
      // Namespaces are the deployment name, sanitised the same way the deploy path does it.
      namespace: String(d.name).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      ...addressOf(d, byType),
    }));

  const platformServices = options?.isAdmin || options?.isEscalated ? CLUSTER_PLATFORM_SERVICES : [];

  return {
    running: [...userServices, ...platformServices],
    /**
     * `unhealthy` and `failed` both mean "deployed and not working" to somebody trying to fix it.
     * `deploying` is excluded: it is not broken, it is not finished.
     */
    broken: deployments
      .filter((d) => d.ownerId === ownerId && (d.status === 'unhealthy' || d.status === 'failed'))
      .map((d) => ({
        name: d.name,
        type: d.appType ?? 'unknown',
        // The probe's own words, when there are any. "Unhealthy" alone sends someone to kubectl.
        reason: d.healthReason?.trim() || `status is ${d.status}`,
      })),
    deployable: (APP_TYPES as readonly AppType[]).map((id) => ({ id, ...APP_FACTS[id] })),
  };
}

/**
 * Whether a named capability exists, for the question a model actually has.
 *
 * Matched against both the running services and the catalogue, because "we have one" and "we could
 * deploy one" lead to different plans and neither is "no".
 */
export function findCapability(
  want: string,
  infra: Infrastructure,
): { running?: RunningService; deployable: boolean } {
  const needle = want.trim().toLowerCase();
  const running = infra.running.find(
    (s) => s.type.toLowerCase() === needle || s.name.toLowerCase().includes(needle),
  );
  return {
    ...(running ? { running } : {}),
    deployable: infra.deployable.some((t) => t.id.toLowerCase() === needle
      || t.provides.some((p) => p === needle)),
  };
}

/**
 * The address and binding type of a deployment, when they are known.
 *
 * Known means a stored spec created it: `renderApp` names the Service after the spec id and takes
 * the port from the spec, so both are facts rather than inferences. Anything built by a
 * hand-written construct names its Service its own way, and this returns nothing rather than
 * guessing.
 */
function addressOf(
  d: DeploymentLike,
  byType: Map<string, { ports?: { port: number }[] }>,
): { address?: string; bindingType?: string } {
  const spec = d.appType ? byType.get(d.appType) : undefined;
  const port = spec?.ports?.[0]?.port;
  if (!spec || port === undefined) return {};
  const namespace = String(d.name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return {
    // The Service is named after the spec, which is the app type — see renderApp.
    address: clusterAuthority({ service: String(d.appType), namespace, port }),
    ...(bindingTypeFor(String(d.appType)) ? { bindingType: bindingTypeFor(String(d.appType))! } : {}),
  };
}
