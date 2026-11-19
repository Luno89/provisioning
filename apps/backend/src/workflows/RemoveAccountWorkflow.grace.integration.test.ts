import { describe, it, expect } from 'vitest';
import { REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId } from '../accounts/lib/account-removal.js';
import type { AccountRemovalActivities } from '../activities/RemoveAccountActivities.js';
import { realTemporalEnvironment } from './testing/temporal-test-env.js';
import { environmentForFile } from './testing/test-worker.js';
import { fakeRemovalSteps, removingAccounts } from './testing/account-removal-steps.js';

const temporal = environmentForFile(realTemporalEnvironment);

const fakeSteps = (seen: string[], over: Partial<AccountRemovalActivities> = {}): AccountRemovalActivities =>
  fakeRemovalSteps(seen, { RemoveAccountFenceActivity: async () => { seen.push('fence'); return ['engine-1']; }, ...over });

describe('removing an account that still had something running', () => {
  it('waits on no timer: it fences the account first, then stops its runs, deletes its repositories and hands its runs over, before anything else is deleted', async () => {
    const seen: string[] = [];
    await removingAccounts(temporal.env, fakeSteps(seen, { RemoveAccountWorkflowsActivity: async () => { seen.push('workflows'); return 2; } }), async (workflows) => {
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('space-1'), [{ ownerId: 'space-1', keepRunsFor: 'bo' }], 'space-1');
      const handle = temporal.env.client.workflow.getHandle(removeAccountWorkflowId('space-1'));
      await handle.result();
      expect(((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes)).toBe(false);
    });
    expect(seen).toEqual(['fence', 'workflows', 'repositories', 'keep for bo', 'apps', 'workspaces', 'secrets', 'mesh', 'records', 'fence ended']);
  });

  it('keeps no runs unless asked', async () => {
    const seen: string[] = [];
    await removingAccounts(temporal.env, fakeSteps(seen), async (workflows) => {
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('grace-cy'), [{ ownerId: 'grace-cy' }], 'grace-cy');
      await temporal.env.client.workflow.getHandle(removeAccountWorkflowId('grace-cy')).result();
    });
    expect(seen).toEqual(['fence', 'workflows', 'repositories', 'apps', 'workspaces', 'secrets', 'mesh', 'records', 'fence ended']);
  });
});
