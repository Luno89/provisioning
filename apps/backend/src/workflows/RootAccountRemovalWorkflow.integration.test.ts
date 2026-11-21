import { describe, it, expect } from 'vitest';
import { KOALA_REMOVAL_QUERY, KOALA_REMOVAL_SIGNAL, MACHINE_REMOVALS_QUERY, MACHINE_UNINSTALLED_SIGNAL, REMOVAL_PROGRESS_QUERY, ROOT_REMOVAL_WORKFLOW, removeAccountWorkflowId, type MachineRemoval } from '../accounts/lib/account-removal.js';
import { until } from '../machines/testing/wiring-world.js';
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
      RootRemovalMachinesActivity: async () => { seen.push('machines'); return []; },
      RootRemovalMeshActivity: async () => { seen.push('mesh'); return { devices: 2, user: true }; },
      RootRemovalRecordsActivity: async () => { seen.push('records'); return { users: 1, instances: 1 }; },
    },
  });
  const result = await worker.runUntil(temporal.env.client.workflow.execute<typeof RootAccountRemovalWorkflow>(ROOT_REMOVAL_WORKFLOW, {
    workflowId: removeAccountWorkflowId('bo'), taskQueue, args: [{ ownerId: 'bo' }], searchAttributes: { KoalaOwner: ['bo'] },
  }));
  return { seen, result };
};

const machinesWorld = async (machines: { id: string; name: string }[]) => {
  const seen: string[] = [];
  const taskQueue = uniqueName('root-removal-machines');
  const worker = await testWorker(temporal.env, {
    taskQueue,
    workflows: 'RootAccountRemovalWorkflow.ts',
    activities: {
      RootRemovalInstanceActivity: async () => { seen.push('find instance'); return {}; },
      RootRemovalMachinesActivity: async () => { seen.push('machines'); return machines; },
      RootRemovalMeshActivity: async () => { seen.push('mesh'); return { devices: machines.length, user: true }; },
      RootRemovalRecordsActivity: async () => { seen.push('records'); return { users: 1 }; },
    },
  });
  const start = () => temporal.env.client.workflow.start<typeof RootAccountRemovalWorkflow>(ROOT_REMOVAL_WORKFLOW, { workflowId: removeAccountWorkflowId(uniqueName('bo')), taskQueue, args: [{ ownerId: 'bo' }], searchAttributes: { KoalaOwner: ['bo'] } });
  return { seen, worker, start };
};

describe('removing an account on root', () => {
  it('stops Koala being put on the person\'s machine, by cancelling its install, before anything else goes', async () => {
    const installId = uniqueName('install');
    const installing = await temporal.env.client.workflow.start('KoalaInstallStandIn', { workflowId: koalaInstallWorkflowId(installId), taskQueue: 'nobody-runs-this', args: [], searchAttributes: { KoalaOwner: ['bo'] } });
    const { seen } = await run(installId);
    expect(seen).toEqual(['find instance', 'machines', 'mesh', 'records']);
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
        RootRemovalMachinesActivity: async () => { seen.push('machines'); return []; },
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
    expect(seen).toEqual(['find instance', 'machines', 'mesh', 'records']);
  });

  it('has each of the person\'s machines uninstall what the join put there, waits for one that is off with no timer, and removes nothing more at root until every machine said it is done', async () => {
    const { seen, worker, start } = await machinesWorld([{ id: 'desk', name: 'Desk' }, { id: 'tower', name: 'Tower' }]);
    await worker.runUntil(async () => {
      const handle = await start();
      const uninstalling = async () => until(async () => {
        const machines = await handle.query<MachineRemoval[]>(MACHINE_REMOVALS_QUERY);
        return machines.length ? machines : undefined;
      });
      expect(await uninstalling()).toEqual([{ id: 'desk', name: 'Desk', state: 'uninstalling' }, { id: 'tower', name: 'Tower', state: 'uninstalling' }]);
      await handle.signal(MACHINE_UNINSTALLED_SIGNAL, { id: 'desk' });
      expect(await handle.query(MACHINE_REMOVALS_QUERY)).toEqual([{ id: 'desk', name: 'Desk', state: 'uninstalled' }, { id: 'tower', name: 'Tower', state: 'uninstalling' }]);
      expect(await handle.query(REMOVAL_PROGRESS_QUERY)).toEqual(['instance', 'koala']);
      expect(seen).toEqual(['find instance', 'machines']);
      await handle.signal(MACHINE_UNINSTALLED_SIGNAL, { id: 'tower' });
      const history = await handle.result().then(() => handle.fetchHistory());
      expect((history.events ?? []).filter((event) => event.timerStartedEventAttributes), 'no timer is waited on').toEqual([]);
    });
    expect(seen).toEqual(['find instance', 'machines', 'mesh', 'records']);
  });

  it('stops with the machine\'s own reason when its uninstall did not finish, and leaves the mesh and records for Try again', async () => {
    const { seen, worker, start } = await machinesWorld([{ id: 'desk', name: 'Desk' }]);
    await worker.runUntil(async () => {
      const handle = await start();
      await until(async () => ((await handle.query<MachineRemoval[]>(MACHINE_REMOVALS_QUERY)).length ? true : undefined));
      await handle.signal(MACHINE_UNINSTALLED_SIGNAL, { id: 'desk', problem: 'k3s is still on this machine: /usr/local/bin/k3s-uninstall.sh did not remove it' });
      const failed = await handle.result().then(() => undefined, (err: { cause?: { message?: string } }) => err.cause?.message);
      expect(failed).toBe('Desk: k3s is still on this machine: /usr/local/bin/k3s-uninstall.sh did not remove it');
    });
    expect(seen).toEqual(['find instance', 'machines']);
  });

  it('unregisters an instance on the person\'s own machine by removing its mesh user and its record', async () => {
    const { seen, result } = await run();
    expect(seen).toEqual(['find instance', 'machines', 'mesh', 'records']);
    expect(result).toEqual({ meshDevices: 2, records: { users: 1, instances: 1 } });
  });
});
