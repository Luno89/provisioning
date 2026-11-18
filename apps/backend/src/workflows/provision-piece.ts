import type { MachineOfCluster, ProvisionPieceInput } from '../infrastructure/index.js';
import { provisionPieceWorkflowId } from '../infrastructure/lib/provisioning.js';
import { QUEUES } from '../platform/lib/work-places.js';
import { startedFor } from '../platform/lib/workflow-owner.js';

export interface ProvisionPieceArgs extends ProvisionPieceInput {
  machine?: MachineOfCluster | undefined;
}

export const provisionPieceStart = (args: ProvisionPieceArgs, taskQueue: string = QUEUES.cluster) => ({
  workflowId: provisionPieceWorkflowId(args.recordId, args.piece),
  taskQueue,
  args: [args] as [ProvisionPieceArgs],
  workflowIdConflictPolicy: 'USE_EXISTING' as const,
  ...startedFor(args.ownerId),
});
