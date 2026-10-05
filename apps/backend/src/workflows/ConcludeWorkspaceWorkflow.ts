import { proxyActivities } from '@temporalio/workflow';
import { DESTROY_RETRY } from '../lib/activity-retry.js';
import type { ConcludeWorkspaceArgs } from '../engine-host/temporal/contracts.js';
import type { SavedDocuments } from '../engine-host/sandboxes/workspace-documents.js';

const { ConcludeWorkspaceActivity } = proxyActivities<{ ConcludeWorkspaceActivity(args: ConcludeWorkspaceArgs): Promise<SavedDocuments> }>({
  retry: DESTROY_RETRY,
  startToCloseTimeout: '10 minutes',
});

/** Saves a finished workspace to Gitea and then deletes it. It fails, deleting nothing, when the save does not work. */
export async function ConcludeWorkspaceWorkflow(args: ConcludeWorkspaceArgs): Promise<SavedDocuments> {
  return ConcludeWorkspaceActivity(args);
}
