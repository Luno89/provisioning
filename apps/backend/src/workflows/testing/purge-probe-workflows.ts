export { PurgeProjectWorkflow } from '../PurgeProjectWorkflow.js';

export async function DeleteProjectWorkflow(args: { projectId: string; mode: string }): Promise<{ deleted: string; mode: string }> {
  return { deleted: args.projectId, mode: args.mode };
}
