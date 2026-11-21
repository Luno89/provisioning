import { describe, it, expect } from 'vitest';
import { DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId } from '../accounts/lib/account-removal.js';
import { realTemporalEnvironment } from './testing/temporal-test-env.js';
import { environmentForFile } from './testing/test-worker.js';
import { fakeRemovalSteps, nothingFrozen, removingAccounts } from './testing/account-removal-steps.js';

const temporal = environmentForFile(realTemporalEnvironment);

const running = { workflowId: 'run-1', type: 'AgentRunWorkflow', startedAt: '2026-11-21T10:00:00.000Z' };

describe('removing an account that still had something running', () => {
  it('waits on no timer: it marks the account first, then stops its runs and waits for them to close, deletes its projects and repositories and hands its runs over, before anything else is deleted', async () => {
    const seen: string[] = [];
    let stops = 0;
    await removingAccounts(temporal.env, fakeRemovalSteps(seen, { StopAccountWorkActivity: async () => { stops += 1; seen.push('workflows'); return stops === 1 ? [running] : []; } }), async (workflows) => {
      await workflows.start(DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('space-1'), [{ ownerId: 'space-1', keepRunsFor: 'bo' }], 'space-1');
      const handle = temporal.env.client.workflow.getHandle(removeAccountWorkflowId('space-1'));
      await handle.result();
      expect(((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes)).toBe(false);
    }, nothingFrozen(seen));
    expect(seen).toEqual(['mark', 'workflows', 'await run-1', 'projects', 'repositories', 'keep for bo', 'apps', 'workspaces', 'secrets', 'workflows', 'mesh', 'records']);
  });

  it('keeps no runs unless asked', async () => {
    const seen: string[] = [];
    await removingAccounts(temporal.env, fakeRemovalSteps(seen), async (workflows) => {
      await workflows.start(DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('grace-cy'), [{ ownerId: 'grace-cy' }], 'grace-cy');
      await temporal.env.client.workflow.getHandle(removeAccountWorkflowId('grace-cy')).result();
    });
    expect(seen).toEqual(['mark', 'workflows', 'projects', 'repositories', 'apps', 'workspaces', 'secrets', 'workflows', 'mesh', 'records']);
  });
});
