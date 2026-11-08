import type { DeploymentMetadata, PipelineRunMetadata } from '../../platform/index.js';

export type FollowedAction = 'app-deploy' | 'app-destroy' | 'app-resize' | 'app-sync-config' | 'pipeline-run';

export const FOLLOWED_DEPLOYMENT_STATUSES = ['deploying', 'destroying'] as const;
export const FOLLOWED_RUN_STATUSES = ['queued', 'running'] as const;

export type FollowedRecord =
  | { kind: 'deployment'; record: DeploymentMetadata }
  | { kind: 'pipeline-run'; record: PipelineRunMetadata };

export function workflowMatch(statuses: readonly string[]): Record<string, unknown> {
  return { status: { $in: [...statuses] }, temporalWorkflowId: { $exists: true, $nin: ['', null] } };
}

export function namesWorkflow(record: { status?: string | undefined; temporalWorkflowId?: string | undefined }, statuses: readonly string[]): boolean {
  return Boolean(record.temporalWorkflowId) && statuses.includes(record.status ?? '');
}

export function followedAction(followed: FollowedRecord): FollowedAction | undefined {
  const { record } = followed;
  if (followed.kind === 'pipeline-run') return namesWorkflow(record, FOLLOWED_RUN_STATUSES) ? 'pipeline-run' : undefined;
  if (!namesWorkflow(record, FOLLOWED_DEPLOYMENT_STATUSES)) return undefined;
  return record.status === 'deploying' ? 'app-deploy' : 'app-destroy';
}
