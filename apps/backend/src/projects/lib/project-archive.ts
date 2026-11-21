export const ARCHIVE_DAYS = 90;
export const PURGE_PROJECT_WORKFLOW = 'PurgeProjectWorkflow';
export const PURGE_NOW_SIGNAL = 'purgeNow';
export const RESTORE_SIGNAL = 'restoreProject';

export const purgeProjectWorkflowId = (projectId: string): string => `purge-project-${projectId}`;

export interface PurgeArgs {
  projectId: string;
}

const purgeOf = (projectId: string, taskQueue: string) => ({
  workflowId: purgeProjectWorkflowId(projectId),
  taskQueue,
  args: [{ projectId }] as [PurgeArgs],
});

export const purgeStart = (projectId: string, taskQueue: string) => ({ ...purgeOf(projectId, taskQueue), startDelay: `${ARCHIVE_DAYS} days` as const });

export const purgeNow = (projectId: string, taskQueue: string) => ({ ...purgeOf(projectId, taskQueue), signal: PURGE_NOW_SIGNAL, signalArgs: [] as [] });

export const restoreProject = (projectId: string, taskQueue: string) => ({ ...purgeOf(projectId, taskQueue), signal: RESTORE_SIGNAL, signalArgs: [] as [] });

export const keptUntil = (described: { executionTime?: Date | undefined }): Date | undefined => described.executionTime;
