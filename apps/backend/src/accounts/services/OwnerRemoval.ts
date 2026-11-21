import { withWorkFor } from '@koala/engine-core/work-for';
import { deletionBegun, deletionEnded, type DeletionProgress } from '../../projects/index.js';
import { DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId } from '../lib/account-removal.js';
import type { AccountRemovalWorkflows } from './AccountRemovalService.js';
import type { RemoveAccountArgs } from '../../activities/RemoveAccountActivities.js';

export interface OwnerRemovalDeps {
  ownerId: string;
  root: {
    ownerRemoving(): Promise<boolean>;
    ownerRemoval(progress: DeletionProgress): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  };
  workflows: AccountRemovalWorkflows<RemoveAccountArgs>;
  now?: () => number;
}

export type OwnerRemovalCheck = 'not-removing' | 'running' | 'started' | 'stopped' | 'deleted';

export class OwnerRemoval {
  constructor(private readonly deps: OwnerRemovalDeps) {}

  async check(why: 'told' | 'connected'): Promise<OwnerRemovalCheck> {
    const { ownerId, root, workflows } = this.deps;
    if (!(await root.ownerRemoving())) return 'not-removing';
    const workflowId = removeAccountWorkflowId(ownerId);
    const current = await workflows.state(workflowId);
    if (current.state === 'running') return 'running';
    if (current.state === 'failed' && why === 'connected') return 'stopped';
    if (current.state === 'finished') {
      const told = await root.ownerRemoval(deletionEnded(deletionBegun((this.deps.now ?? Date.now)() * 1000), { phase: 'deleted' }));
      if (!told.ok) throw new Error(`root would not hear that this Koala's owner is deleted: ${told.error}`);
      return 'deleted';
    }
    await withWorkFor({ owner: ownerId, removing: 'owner' }, () => workflows.start(DELETE_ACCOUNT_WORKFLOW, workflowId, [{ ownerId, toRoot: true }], ownerId));
    return 'started';
  }
}
