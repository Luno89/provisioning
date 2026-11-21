import { defineSignal, executeChild, setHandler } from '@temporalio/workflow';
import { DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId } from '../projects/lib/project-removal.js';
import { PURGE_NOW_SIGNAL, RESTORE_SIGNAL, type PurgeArgs } from '../projects/lib/project-archive.js';

export const purgeNowSignal = defineSignal(PURGE_NOW_SIGNAL);
export const restoreSignal = defineSignal(RESTORE_SIGNAL);

export async function PurgeProjectWorkflow({ projectId }: PurgeArgs): Promise<{ purged: string[] }> {
  let restored = false;
  setHandler(restoreSignal, () => { restored = true; });
  setHandler(purgeNowSignal, () => undefined);
  if (restored) return { purged: [] };
  await executeChild(DELETE_PROJECT_WORKFLOW, { workflowId: deleteProjectWorkflowId(projectId), args: [{ projectId, mode: 'permanent' }] });
  return { purged: [projectId] };
}
