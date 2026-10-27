import type { ProjectMetadata } from '../../platform/index.js';

export function webhookUrlFor(nodeIpRaw: string, port: string | number, projectId: string): string {
  const ip = nodeIpRaw.trim().split(/\s+/)[0] ?? '';
  return `http://${ip}:${port}/webhooks/gitea/${projectId}`;
}

export function shippingGaps(
  project: Pick<ProjectMetadata, 'webhookSecretEnc' | 'targetClusterId' | 'autoDeployOnBuild'>,
): string[] {
  const gaps: string[] = [];
  if (!project.webhookSecretEnc) gaps.push('no webhook, so pushes will not build it');
  if (!project.targetClusterId) gaps.push('no target cluster, so a built image has nowhere to go');
  return gaps;
}

export function deploysItself(
  project: Pick<ProjectMetadata, 'webhookSecretEnc' | 'targetClusterId' | 'autoDeployOnBuild'>,
): boolean {
  return shippingGaps(project).length === 0 && project.autoDeployOnBuild === true;
}

export function isShippable(project: Pick<ProjectMetadata, 'webhookSecretEnc' | 'targetClusterId'>): boolean {
  return shippingGaps(project).length === 0;
}

export const DEFAULT_TARGET_CLUSTER = 'provisioning-lunorica';

export function targetClusterProblem(asked: unknown, clusters: readonly { id: string; ownerId?: string | undefined }[], ownerId: string): string | undefined {
  if (asked === undefined || asked === null || asked === '' || asked === DEFAULT_TARGET_CLUSTER) return undefined;
  return clusters.some((cluster) => cluster.id === asked && cluster.ownerId === ownerId) ? undefined : 'Deploy to the system cluster or one of your own clusters.';
}
