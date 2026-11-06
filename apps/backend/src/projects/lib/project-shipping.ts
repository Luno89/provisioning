import type { ProjectMetadata } from '../../platform/index.js';
import { machineClusterId } from '../../infrastructure/lib/cluster-name.js';

export function webhookUrlFor(nodeIpRaw: string, port: string | number, projectId: string): string {
  const ip = nodeIpRaw.trim().split(/\s+/)[0] ?? '';
  return `http://${ip}:${port}/webhooks/gitea/${projectId}`;
}

export const webhookUrlAt = (backend: string, projectId: string): string => `${backend.replace(/\/+$/, '')}/webhooks/gitea/${projectId}`;

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

export const koalasClusterFor = (env: Readonly<Record<string, string | undefined>>): string => {
  const machine = env.INSTANCE_MACHINE_ID?.trim();
  return machine ? machineClusterId(machine) : DEFAULT_TARGET_CLUSTER;
};

const pathOf = (url: string): string | undefined => {
  try { return new URL(url).pathname; } catch { return undefined; }
};

export const sameHookPath = (url: string | undefined, target: string): boolean =>
  url === target || (url !== undefined && pathOf(url) !== undefined && pathOf(url) === pathOf(target));

export const namesTargetCluster = (asked: unknown): asked is string => typeof asked === 'string' && asked !== '';

export function targetClusterProblem(asked: unknown, deployable: boolean): string | undefined {
  if (asked === undefined || asked === null || asked === '') return undefined;
  return namesTargetCluster(asked) && deployable ? undefined : 'Deploy to the system cluster or one of your own clusters.';
}
