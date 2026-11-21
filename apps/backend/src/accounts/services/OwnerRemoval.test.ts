import { describe, expect, it } from 'vitest';
import { workFor } from '@koala/engine-core/work-for';
import { OwnerRemoval } from './OwnerRemoval.js';
import type { RemovalWorkflowState } from './AccountRemovalService.js';
import type { DeletionProgress } from '../../projects/index.js';

const world = (removing: boolean, state: RemovalWorkflowState) => {
  const started: Array<{ type: string; id: string; args: unknown; owner: string; work: unknown }> = [];
  const told: DeletionProgress[] = [];
  const removal = new OwnerRemoval({
    ownerId: 'bo',
    root: { ownerRemoving: async () => removing, ownerRemoval: async (progress) => { told.push(progress); return { ok: true }; } },
    workflows: {
      start: async (type, id, args, owner) => { started.push({ type, id, args: args[0], owner, work: workFor() }); },
      state: async () => state,
    },
    now: () => 1_000,
  });
  return { removal, started, told };
};

describe('this Koala removing its owner when root removes their account', () => {
  it('does nothing while root is not removing its owner', async () => {
    const { removal, started, told } = world(false, { state: 'none' });
    expect(await removal.check('told')).toBe('not-removing');
    expect(started).toEqual([]);
    expect(told).toEqual([]);
  });

  it('starts removing its owner the way an account is removed, telling root as it goes, as the owner\'s own removal', async () => {
    const { removal, started } = world(true, { state: 'none' });
    expect(await removal.check('connected')).toBe('started');
    expect(started).toEqual([{ type: 'DeleteAccountWorkflow', id: 'remove-account-bo', args: { ownerId: 'bo', toRoot: true }, owner: 'bo', work: { owner: 'bo', removing: 'owner' } }]);
  });

  it('starts nothing more while the removal runs', async () => {
    const { removal, started } = world(true, { state: 'running', done: [] });
    expect(await removal.check('told')).toBe('running');
    expect(started).toEqual([]);
  });

  it('tries a removal that stopped again only when root tells it to, never on its own when it reconnects', async () => {
    const reconnected = world(true, { state: 'failed', reason: 'Gitea would not delete the user koala-bo (HTTP 403)' });
    expect(await reconnected.removal.check('connected')).toBe('stopped');
    expect(reconnected.started).toEqual([]);
    const told = world(true, { state: 'failed', reason: 'Gitea would not delete the user koala-bo (HTTP 403)' });
    expect(await told.removal.check('told')).toBe('started');
    expect(told.started).toHaveLength(1);
  });

  it('tells root again that its owner is deleted when the removal had already finished', async () => {
    const { removal, started, told } = world(true, { state: 'finished' });
    expect(await removal.check('connected')).toBe('deleted');
    expect(started).toEqual([]);
    expect(told).toEqual([expect.objectContaining({ phase: 'deleted' })]);
  });
});
