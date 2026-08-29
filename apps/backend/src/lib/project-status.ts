import type { DeploymentMetadata, PipelineRunMetadata, ProjectMetadata } from './types.js';

export type ProjectStatus =
  | 'no-build'
  | 'building'
  | 'build-failed'
  | 'built'
  | 'deploying'
  | 'deploy-failed'
  | 'unhealthy'
  | 'running';

export interface ProjectStatusResult {
  status: ProjectStatus;
  reason: string;
}

export function rollupProjectStatus(
  project: Pick<ProjectMetadata, 'id'>,
  runs: PipelineRunMetadata[],
  deployment: DeploymentMetadata | undefined,
): ProjectStatusResult {
  const mine = runs
    .filter((r) => r.projectId === project.id)
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  const latest = mine[0];

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
  return { status: 'built', reason: '' };
}

export function deploymentForProject(
  project: Pick<ProjectMetadata, 'id' | 'name'>,
  deployments: DeploymentMetadata[],
): DeploymentMetadata | undefined {
  return (
    deployments.find((d) => d.gitappProjectId === project.id) ??
    deployments.find((d) => d.appType === 'gitapp' && d.name === project.name)
  );
}
