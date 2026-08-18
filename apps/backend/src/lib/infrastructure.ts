import { APP_TYPES, APP_FACTS, type AppType } from './app-catalog.js';

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
  /** Where it lives in the cluster. The address is derived from this at deploy time, not here. */
  namespace: string;
}

export interface Infrastructure {
  running: RunningService[];
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
}

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
): Infrastructure {
  return {
    running: deployments
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
