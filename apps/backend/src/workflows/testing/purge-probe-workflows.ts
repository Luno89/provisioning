import { workflowInfo } from '@temporalio/workflow';
import { ownerIn } from '../../platform/lib/workflow-owner.js';

export { PurgeProjectWorkflow } from '../PurgeProjectWorkflow.js';

export async function DeleteProjectWorkflow(args: { projectId: string; mode: string }): Promise<{ deleted: string; mode: string; owner: string | undefined }> {
  return { deleted: args.projectId, mode: args.mode, owner: ownerIn(workflowInfo().typedSearchAttributes) };
}
