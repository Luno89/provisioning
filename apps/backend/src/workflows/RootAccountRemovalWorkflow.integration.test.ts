import { describe, it, expect } from 'vitest';
import { KOALA_REMOVAL_QUERY, KOALA_REMOVAL_SIGNAL, REMOVAL_PROGRESS_QUERY, ROOT_REMOVAL_WORKFLOW, removeAccountWorkflowId } from '../accounts/lib/account-removal.js';
import { temporalTestEnvironment } from './testing/temporal-test-env.js';
import { environmentForFile, uniqueName, testWorker } from './testing/test-worker.js';
import { koalaInstallWorkflowId } from '../instances/lib/koala-installs.js';
import type { RootAccountRemovalWorkflow } from './RootAccountRemovalWorkflow.js';

const temporal = environmentForFile(temporalTestEnvironment);

const run = async (installId?: string) => {
  const seen: string[] = [];
  const taskQueue = uniqueName('root-removal-test');
  const worker = await testWorker(temporal.env, {
    taskQueue,
    workflows: 'RootAccountRemovalWorkflow.ts',
    activities: {
      RootRemovalInstanceActivity: async () => { seen.push('find instance'); return installId ? { installId } : {}; },
      RootRemovalMeshActivity: async () => { seen.push('mesh'); return { devices: 2, user: true }; },
      RootRemovalRecordsActivity: async () => { seen.push('records'); return { users: 1, instances: 1 }; },
    },
  });
  const result = await worker.runUntil(temporal.env.client.workflow.execute<typeof RootAccountRemovalWorkflow>(ROOT_REMOVAL_WORKFLOW, {
    workflowId: removeAccountWorkflowId('bo'), taskQueue, args: [{ ownerId: 'bo' }], searchAttributes: { KoalaOwner: ['bo'] },
  }));
  return { seen, result };
};

describe('removing an account on root', () => {
  it('stops Koala being put on the person\'s machine, by cancelling its install, before anything else goes', async () => {
    const installId = uniqueName('install');
    const installing = await temporal.env.client.workflow.start('KoalaInstallStandIn', { workflowId: koalaInstallWorkflowId(installId), taskQueue: 'nobody-runs-this', args: [], searchAttributes: { KoalaOwner: ['bo'] } });
    const { seen } = await run(installId);
    expect(seen).toEqual(['find instance', 'mesh', 'records']);
    const history = await installing.fetchHistory();
    expect(history.events?.some((event) => event.workflowExecutionCancelRequestedEventAttributes)).toBe(true);
  });

  it('waits for the person\'s own Koala to remove its owner, showing how it stands, and removes nothing at root until the Koala says its owner is deleted', async () => {
    const seen: string[] = [];
    const taskQueue = uniqueName('root-removal-koala');
    const worker = await testWorker(temporal.env, {
      taskQueue,
      workflows: 'RootAccountRemovalWorkflow.ts',
      activities: {
        RootRemovalInstanceActivity: async () => { seen.push('find instance'); return { koala: 'inst-bo' }; },
        RootRemovalMeshActivity: async () => { seen.push('mesh'); return { devices: 1, user: true }; },
        RootRemovalRecordsActivity: async () => { seen.push('records'); return { users: 1 }; },
      },
    });
    const workflowId = removeAccountWorkflowId(uniqueName('bo'));
    await worker.runUntil(async () => {
      const handle = await temporal.env.client.workflow.start<typeof RootAccountRemovalWorkflow>(ROOT_REMOVAL_WORKFLOW, { workflowId, taskQueue, args: [{ ownerId: 'bo' }], searchAttributes: { KoalaOwner: ['bo'] } });
      const deleting = { seq: 5, phase: 'deleting' as const, work: [{ workflowId: 'run-1', type: 'AgentRunWorkflow', startedAt: '2026-11-21T10:00:00.000Z', state: 'stopping' as const }], parts: {} };
      await handle.signal(KOALA_REMOVAL_SIGNAL, deleting);
      expect(await handle.query(KOALA_REMOVAL_QUERY)).toEqual(deleting);
      await handle.signal(KOALA_REMOVAL_SIGNAL, { ...deleting, seq: 4, work: [] });
      expect(await handle.query(KOALA_REMOVAL_QUERY), 'an older word from the Koala never replaces a newer one').toEqual(deleting);
      expect(await handle.query(REMOVAL_PROGRESS_QUERY)).toEqual(['instance']);
      expect(seen).toEqual(['find instance']);
      await handle.signal(KOALA_REMOVAL_SIGNAL, { seq: 9, phase: 'deleted', work: [], parts: {} });
      await handle.result();
      expect(((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes)).toBe(false);
    });
    expect(seen).toEqual(['find instance', 'mesh', 'records']);
  });

  it('unregisters an instance on the person\'s own machine by removing its mesh user and its record', async () => {
    const { seen, result } = await run();
    expect(seen).toEqual(['find instance', 'mesh', 'records']);
    expect(result).toEqual({ meshDevices: 2, records: { users: 1, instances: 1 } });
  });
});
