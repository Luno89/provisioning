import { activityInterceptors, WORKER_DEFAULTS } from '@koala/engine-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { MachineProgress } from '@koala/engine-core/machine-progress';
import { KOALA_INSTALL_SIGNALS, koalaInstallWorkflowId } from '../instances/lib/koala-installs.js';
import type { InstallAnswer, InstallHeard } from '../activities/KoalaInstallActivities.js';
import { bundled, temporalTestEnvironment } from './temporal-test-env.js';
import type { KoalaInstallWorkflow } from './KoalaInstallWorkflow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let env: TestWorkflowEnvironment;

beforeAll(async () => { env = await temporalTestEnvironment(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

type Handle = { signal: (name: string, ...args: unknown[]) => Promise<void>; cancel: () => Promise<void> };

async function run(answers: (heard: InstallHeard) => InstallAnswer, drive: (handle: Handle, seen: string[]) => Promise<void>, ask: () => InstallAnswer = () => 'asked') {
  const seen: string[] = [];
  const taskQueue = `koala-install-test-${Math.random().toString(36).slice(2, 8)}`;
  const installId = `install-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({
    interceptors: { activity: activityInterceptors() },
    ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default',
    taskQueue,
    workflowBundle: await bundled(resolve(__dirname, 'KoalaInstallWorkflow.ts')),
    activities: {
      KoalaInstallAskActivity: async () => { seen.push('ask'); return ask(); },
      KoalaInstallStageActivity: async (heard: InstallHeard) => {
        const progress = 'setup' in heard ? heard.setup.progress : heard.progress;
        seen.push(`${'setup' in heard ? `setup ${heard.setup.revision} ` : ''}${progress.stage} ${progress.state}${progress.line ? ` ${progress.line}` : ''}`);
        return answers(heard);
      },
    },
  });
  const result = await worker.runUntil(async () => {
    const handle = await env.client.workflow.start<typeof KoalaInstallWorkflow>('KoalaInstallWorkflow', {
      workflowId: koalaInstallWorkflowId(installId), taskQueue, args: [{ installId }], searchAttributes: { KoalaOwner: ['bo'] },
    });
    await drive({ signal: (name, ...args) => handle.signal(name, ...args), cancel: async () => { await handle.cancel(); } }, seen);
    return handle.result().then((ended) => ended, (err: unknown) => err);
  });
  return { seen, result };
}

const until = async (seen: string[], count: number) => { while (seen.length < count) await new Promise((done) => setTimeout(done, 20)); };
const stage = (stage: string, state: MachineProgress['state'], more: Partial<MachineProgress> = {}): MachineProgress => ({ stage, title: stage, state, ...more });
const installing = (heard: InstallHeard): InstallAnswer => {
  if ('setup' in heard) return heard.setup.progress.state === 'failed' ? 'failed' : 'installing';
  if (heard.progress.state === 'failed') return 'failed';
  return heard.progress.stage === 'koala' && heard.progress.state === 'done' ? 'ready' : 'installing';
};

describe('root driving Koala onto a machine', () => {
  it('asks the machine, records each stage it hears in order, and ends ready when the last stage is done', async () => {
    const { seen, result } = await run(installing, async (handle) => {
      await handle.signal(KOALA_INSTALL_SIGNALS.progress, stage('cluster', 'started'));
      await handle.signal(KOALA_INSTALL_SIGNALS.progress, stage('cluster', 'done'));
      await handle.signal(KOALA_INSTALL_SIGNALS.progress, stage('koala', 'started', { line: 'waiting for job/instance-seed-1 runs' }));
      await handle.signal(KOALA_INSTALL_SIGNALS.progress, stage('koala', 'done', { url: 'https://bo.koala.app' }));
    });
    expect(seen).toEqual(['ask', 'cluster started', 'cluster done', 'koala started waiting for job/instance-seed-1 runs', 'koala done']);
    expect(result).toBe('ready');
  });

  it('hears Koala setting itself up on the same line as the machine\'s stages, in the order they come, and ends when what it heard ends the install', async () => {
    const setUpEnds = (heard: InstallHeard): InstallAnswer => ('setup' in heard && heard.setup.progress.stage === 'set-up' ? 'ready' : 'installing');
    const { seen, result } = await run(setUpEnds, async (handle) => {
      await handle.signal(KOALA_INSTALL_SIGNALS.progress, stage('koala', 'started'));
      await handle.signal(KOALA_INSTALL_SIGNALS.setup, { revision: 1, progress: stage('gitea', 'started', { line: 'waiting for statefulset/gitea' }) });
      await handle.signal(KOALA_INSTALL_SIGNALS.progress, stage('koala', 'done', { url: 'https://bo.koala.app' }));
      await handle.signal(KOALA_INSTALL_SIGNALS.setup, { revision: 1, progress: stage('gitea', 'done') });
      await handle.signal(KOALA_INSTALL_SIGNALS.setup, { revision: 1, progress: stage('set-up', 'done') });
    });
    expect(seen).toEqual(['ask', 'koala started', 'setup 1 gitea started waiting for statefulset/gitea', 'koala done', 'setup 1 gitea done', 'setup 1 set-up done']);
    expect(result).toBe('ready');
  });

  it('asks again each time the machine comes back before the install finished, and goes on from what it hears', async () => {
    const { seen, result } = await run(installing, async (handle, heard) => {
      await until(heard, 1);
      await handle.signal(KOALA_INSTALL_SIGNALS.progress, stage('cluster', 'started'));
      await until(heard, 2);
      await handle.signal(KOALA_INSTALL_SIGNALS.reconnected);
      await until(heard, 3);
      await handle.signal(KOALA_INSTALL_SIGNALS.progress, stage('koala', 'already-done'));
      await handle.signal(KOALA_INSTALL_SIGNALS.progress, stage('koala', 'done', { url: 'https://bo.koala.app' }));
    });
    expect(seen).toEqual(['ask', 'cluster started', 'ask', 'koala already-done', 'koala done']);
    expect(result).toBe('ready');
  });

  it('ends failed at the stage the machine says it stopped at', async () => {
    const { seen, result } = await run(installing, async (handle) => {
      await handle.signal(KOALA_INSTALL_SIGNALS.progress, stage('koala', 'failed', { why: 'job/instance-seed-1 failed' }));
    });
    expect(seen).toEqual(['ask', 'koala failed']);
    expect(result).toBe('failed');
  });

  it('ends without touching anything once another install has taken the instance\'s place', async () => {
    const { seen, result } = await run(installing, async () => undefined, () => 'replaced');
    expect(seen).toEqual(['ask']);
    expect(result).toBe('replaced');
  });

  it('waits on the machine however long it takes, and stops only when cancelled', async () => {
    const { seen, result } = await run(installing, async (handle, heard) => {
      await until(heard, 1);
      await env.sleep('30 days');
      await handle.cancel();
    });
    expect(seen).toEqual(['ask']);
    expect(result).toBeInstanceOf(WorkflowFailedError);
  });
});
