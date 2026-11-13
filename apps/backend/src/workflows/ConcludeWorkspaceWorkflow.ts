import { patched, proxyActivities } from '@temporalio/workflow';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import type { ConcludeWorkspaceArgs } from '../engine-host/temporal/contracts.js';
import type { SavedDocuments } from '../engine-host/sandboxes/workspace-documents.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { nameProject } from './telemetry-interceptors.js';

const { ConcludeWorkspaceActivity, WorkspaceProjectActivity } = proxyActivities<{
  ConcludeWorkspaceActivity(args: ConcludeWorkspaceArgs): Promise<SavedDocuments>;
  WorkspaceProjectActivity(args: ConcludeWorkspaceArgs): Promise<string | null>;
}>({
  retry: ACTIVITY_RETRY,
  ...LIVE_ACTIVITY,
});

const CONCLUSION_NAMES_PROJECT = 'conclusion-names-project';

export async function ConcludeWorkspaceWorkflow(args: ConcludeWorkspaceArgs): Promise<SavedDocuments> {
  if (patched(CONCLUSION_NAMES_PROJECT)) nameProject((await WorkspaceProjectActivity(args)) ?? undefined);
  return ConcludeWorkspaceActivity(args);
}
