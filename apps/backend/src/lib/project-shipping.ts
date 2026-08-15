/**
 * Making a project able to become a running deployment.
 *
 * ── WHY THIS WAS MISSING FOR EVERYTHING KOALA BUILDS ──
 * A project only builds when Gitea posts a push webhook, and only deploys when it knows which
 * cluster to deploy to. `POST /api/projects` does both when a person creates a project by hand.
 * `resolveLeafProject` — the path EVERY project Koala creates goes through — did neither, so the
 * repositories the agent actually fills with code were the ones that could never ship.
 *
 * Measured on this instance: four projects, all of them agent-created, all with no webhook and no
 * target cluster. The pipeline machinery worked the whole time; nothing was ever wired to it.
 *
 * The pure parts live here so both callers agree on what "shippable" means and neither has to
 * re-derive it.
 */
import type { ProjectMetadata } from './types.js';

/**
 * Where Gitea should post.
 *
 * The node's own address, not localhost: Gitea runs in the cluster and the backend runs on the
 * host, so a loopback URL resolves inside Gitea's container to Gitea itself.
 *
 * A dual-stack node reports several InternalIPs space-joined, and the whole string produced a URL
 * Gitea rejected outright — hence the split. IPv4 is always first.
 */
export function webhookUrlFor(nodeIpRaw: string, port: string | number, projectId: string): string {
  const ip = nodeIpRaw.trim().split(/\s+/)[0] ?? '';
  return `http://${ip}:${port}/webhooks/gitea/${projectId}`;
}

/**
 * What a project still needs before a push can turn into a running deployment.
 *
 * Returned as a list rather than a boolean so the caller can say WHICH part is missing — "not
 * shippable" is the kind of answer that costs an hour.
 */
export function shippingGaps(
  project: Pick<ProjectMetadata, 'webhookSecretEnc' | 'targetClusterId' | 'autoDeployOnBuild'>,
): string[] {
  const gaps: string[] = [];
  if (!project.webhookSecretEnc) gaps.push('no webhook, so pushes will not build it');
  if (!project.targetClusterId) gaps.push('no target cluster, so a built image has nowhere to go');
  // Not a gap in being DEPLOYABLE — a build can still be promoted by hand — so it is reported
  // separately rather than making the project look broken.
  return gaps;
}

/** Whether a push runs all the way to a deployment without anyone pressing anything. */
export function deploysItself(
  project: Pick<ProjectMetadata, 'webhookSecretEnc' | 'targetClusterId' | 'autoDeployOnBuild'>,
): boolean {
  return shippingGaps(project).length === 0 && project.autoDeployOnBuild === true;
}

export function isShippable(project: Pick<ProjectMetadata, 'webhookSecretEnc' | 'targetClusterId'>): boolean {
  return shippingGaps(project).length === 0;
}

/**
 * The cluster an agent-created project deploys to when nobody chose one.
 *
 * The management cluster, because it is the one that always exists — a project whose target was
 * left unset could never be promoted, and asking the planner to pick a cluster is asking it to
 * decide something it has no basis for.
 */
export const DEFAULT_TARGET_CLUSTER = 'provisioning-lunorica';
