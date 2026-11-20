import { describe, it, expect } from 'vitest';
import { ROOT_REMOVAL_WORKFLOW, removeAccountWorkflowId } from '../accounts/lib/account-removal.js';
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

  it('unregisters an instance on the person\'s own machine by removing its mesh user and its record', async () => {
    const { seen, result } = await run();
    expect(seen).toEqual(['find instance', 'mesh', 'records']);
    expect(result).toEqual({ meshDevices: 2, records: { users: 1, instances: 1 } });
  });
});
