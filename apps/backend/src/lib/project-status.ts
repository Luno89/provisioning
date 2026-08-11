/**
 * One word for "is this project actually working".
 *
 * ── WHY THIS EXISTS ──
 * A project's state is spread across three records that nothing joined up: the project's own
 * `lastBuildStatus`, its pipeline runs, and the deployment its promoted image is running in. The
 * Projects list showed the first two, so it could say a project had built successfully while its
 * pod had been in CrashLoopBackOff for an hour. "Built" was being read as "works".
 *
 * ── WORST STATE WINS ──
 * The rollup reports the worst thing in the chain rather than the furthest point reached. That is
 * the whole value of a single indicator: green has to mean it built, deployed AND runs, or nobody
 * can trust it at a glance. A project whose newest build failed reads `build-failed` even if an
 * older image is still serving happily — because the thing you asked for is not what is running.
 *
 * ── WHY SERVER-SIDE ──
 * The same question is asked from the Projects list and from a Koala branch, and a rule about what
 * counts as healthy should not be written twice and drift. Pure, so it can be tested against the
 * combinations rather than by staring at a dashboard.
 */
import type { DeploymentMetadata, PipelineRunMetadata, ProjectMetadata } from './types.js';

export type ProjectStatus =
  /** No pipeline run has ever finished — there is nothing to deploy yet. */
  | 'no-build'
  | 'building'
  | 'build-failed'
  /** An image exists and nothing is running it. Not a failure; a step not taken. */
  | 'built'
  | 'deploying'
  /** The deploy itself did not land — see DeploymentMetadata.status for the distinction. */
  | 'deploy-failed'
  /** It deployed and the workload is not running. */
  | 'unhealthy'
  | 'running';

export interface ProjectStatusResult {
  status: ProjectStatus;
  /** Human-readable detail for the failing cases: a build error, or the pod's health reason. */
  reason: string;
}

/** Bad news first. Anything at or above the first match wins over anything later in the chain. */
export function rollupProjectStatus(
  project: Pick<ProjectMetadata, 'id'>,
  runs: PipelineRunMetadata[],
  deployment: DeploymentMetadata | undefined,
): ProjectStatusResult {
  const mine = runs
    .filter((r) => r.projectId === project.id)
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  const latest = mine[0];

  // Build problems outrank a running pod: whatever is serving is not what was last asked for.
  if (latest?.status === 'failed') {
    return { status: 'build-failed', reason: latest.errorMessage ?? 'the build failed' };
  }
  if (latest?.status === 'queued' || latest?.status === 'running') {
    return { status: 'building', reason: '' };
  }

  if (deployment) {
    if (deployment.status === 'unhealthy') {
      return { status: 'unhealthy', reason: deployment.healthReason ?? 'the workload is not running' };
    }
    if (deployment.status === 'failed') return { status: 'deploy-failed', reason: 'the deploy did not complete' };
    if (deployment.status === 'deploying' || deployment.status === 'destroying') {
      return { status: 'deploying', reason: '' };
    }
    if (deployment.status === 'running') return { status: 'running', reason: '' };
  }

  if (!latest) return { status: 'no-build', reason: '' };
  // A successful build that nothing is running. Deliberately not an error — plenty of projects are
  // never meant to be deployed, and colouring them red would train people to ignore the column.
  return { status: 'built', reason: '' };
}

/**
 * The deployment belonging to a project.
 *
 * Prefers the recorded `gitappProjectId`. Falls back to matching on name because that field is new
 * — every deployment promoted before it existed has none, and those are exactly the ones already
 * running that people will look at first. The fallback is scoped to gitapp deployments so an
 * unrelated app that happens to share a name cannot be claimed by a project.
 */
export function deploymentForProject(
  project: Pick<ProjectMetadata, 'id' | 'name'>,
  deployments: DeploymentMetadata[],
): DeploymentMetadata | undefined {
  return (
    deployments.find((d) => d.gitappProjectId === project.id) ??
    deployments.find((d) => d.appType === 'gitapp' && d.name === project.name)
  );
}
