import type { ProjectMetadata } from './types.js';

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
