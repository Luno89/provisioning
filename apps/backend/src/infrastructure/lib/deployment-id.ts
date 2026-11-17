import { createHash } from 'node:crypto';

export function deriveDeploymentId(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 8);
}

export function deploymentIdFor(
  stored: string | undefined,
  identity: string,
): string {
  return stored || deriveDeploymentId(identity);
}

export class AppStackUnknown extends Error {
  readonly status = 409;
}

export const appStackName = (clusterName: string, deploymentId: string): string => `app-${clusterName}-${deploymentId}`;

export function appStackOf(dep: { name: string; deploymentId?: string | undefined }, cluster: { name?: string | undefined } | undefined): { deploymentId: string; clusterName: string } {
  if (!dep.deploymentId) throw new AppStackUnknown(`${dep.name} was deployed before Koala recorded which Terraform state is its, so it cannot be destroyed, resized or changed through Koala`);
  if (!cluster?.name) throw new AppStackUnknown(`the cluster ${dep.name} runs on has no name, so its Terraform state cannot be named`);
  return { deploymentId: dep.deploymentId, clusterName: cluster.name };
}

export const NO_STACK_ID = 'was handed no stack id, so it cannot tell which Terraform state is the app\'s';
