import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { temporalTestEnvironment } from './temporal-test-env.js';
import { startedFor } from '../lib/workflow-owner.js';
import { slotStateFrom, type SlotState } from '../lib/odoo-release.js';
import type { OdooReleaseActivities, ReleaseTarget } from '../activities/OdooReleaseActivities.js';
import type { ReleaseBrowserTestActivities, ReleaseBrowserTestsInput } from '../activities/ReleaseBrowserTestsActivity.js';
import { DEFAULT_ENGINE_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import type { ReleaseE2E } from '../lib/release-e2e.js';
import type { ReleaseBuild, ReleaseProgress } from './OdooReleaseWorkflow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await temporalTestEnvironment(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

const target: ReleaseTarget = { clusterName: 'dev', provider: 'k3d', namespace: 'shop', release: 'shop' };
const input = { target, host: 'shop.apps.local', previewHost: 'shop-preview.apps.local', ownerId: 'bo', e2eMinutes: 20 };
const PASSED: ReleaseE2E = { state: 'passed', summary: '1 passed, 0 failed', startedAt: 't0', finishedAt: 't1' };
const build = (id: string, tag: string): ReleaseBuild => ({ releaseId: id, image: `reg/bo/shop:${tag}`, source: { owner: 'bo', repo: 'shop', commit: tag } });

function cluster(start: SlotState, options: { failJob?: string; failOnTry?: number; gate?: 'pass' | 'hold' } = {}) {
  let values: SlotState = start;
  const log: string[] = [];
  const gates: ReleaseBrowserTestsInput[] = [];
  const browser: ReleaseBrowserTestActivities = {
    ReleaseBrowserTestsActivity: async (request) => {
      gates.push(request);
      log.push(`browser ${request.releaseId} slot ${request.slot}`);
      if (options.gate !== 'hold') return PASSED;
      const signal = Context.current().cancellationSignal;
      while (!signal.aborted) {
        Context.current().heartbeat();
        await new Promise((done) => setTimeout(done, 50));
      }
      log.push(`browser ${request.releaseId} stopped`);
      throw new Error('stopped');
    },
  };
  const tries = new Map<string, number>();
  const jobs: { name: string; manifest: Record<string, unknown> }[] = [];
  const valuesOf = (sets: string[]) => Object.fromEntries(sets.filter((_, i) => i % 2 === 1).map((pair) => pair.split('=') as [string, string]));
  const activities: OdooReleaseActivities = {
    OdooReleaseStateActivity: async () => values,
    OdooReleaseModulesActivity: async () => ['sale_note'],
    OdooReleaseApplyActivity: async ({ sets }) => {
      const set = valuesOf(sets);
      values = slotStateFrom({ live: set.live, previewHost: set.previewHost, slots: { a: { tag: set['slots.a.tag'] }, b: { tag: set['slots.b.tag'] } } });
      log.push(`helm live=${set.live} a=${set['slots.a.tag'] || '-'} b=${set['slots.b.tag'] || '-'}${set.previewHost ? ' preview' : ''}`);
    },
    OdooReleaseWaitActivity: async ({ workload }) => { log.push(`ready ${workload}`); },
    OdooReleaseCopyDatabaseActivity: async ({ from, to }) => { log.push(`copy ${from}>${to}`); },
    OdooReleaseInstalledActivity: async () => ['base', 'sale_note'],
    OdooReleaseVaultActivity: async ({ vault }) => { log.push(`vault ${vault.secret} ${vault.keys.join(',')}`); },
    OdooReleaseJobActivity: async ({ name, manifest }) => {
      jobs.push({ name, manifest });
      tries.set(name, (tries.get(name) ?? 0) + 1);
      if (name === options.failJob && tries.get(name) === (options.failOnTry ?? 1)) throw new Error(`${name} failed: odoo.modules.registry: Failed to load registry`);
      log.push(`job ${name}`);
    },
    OdooReleaseScaleActivity: async ({ slot, replicas }) => { log.push(`scale ${slot}=${replicas}`); },
    OdooReleaseQuietActivity: async ({ database }) => { log.push(`quiet ${database}`); },
  };
  return { activities, browser, gates, log, jobs, values: () => values };
}

async function withWorker(made: { activities: OdooReleaseActivities; browser: ReleaseBrowserTestActivities }, body: (queue: string) => Promise<void>) {
  const taskQueue = `odoo-release-test-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: resolve(__dirname, 'index.ts'), activities: made.activities });
  const engine = await Worker.create({ connection: env.nativeConnection, taskQueue: DEFAULT_ENGINE_TASK_QUEUE, activities: made.browser, shutdownGraceTime: '1 second' });
  await engine.runUntil(() => worker.runUntil(() => body(taskQueue)));
}

const e2eOf = async (workflowId: string, releaseId: string, state: string): Promise<ReleaseE2E> => {
  for (let tries = 0; tries < 200; tries += 1) {
    const all = await env.client.workflow.getHandle(workflowId).query<Record<string, ReleaseProgress>>('releases');
    if (all[releaseId]?.e2e?.state === state) return all[releaseId]!.e2e!;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`${releaseId}'s browser tests never became ${state}`);
};

const progressOf = async (workflowId: string, releaseId: string, state: string): Promise<ReleaseProgress> => {
  for (let tries = 0; tries < 200; tries += 1) {
    const all = await env.client.workflow.getHandle(workflowId).query<Record<string, ReleaseProgress>>('releases');
    if (all[releaseId]?.state === state) return all[releaseId]!;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`${releaseId} never became ${state}`);
};

const LIVE_A: SlotState = { installed: true, live: 'a', tags: { a: 'one', b: undefined } };

describe('releasing an Odoo project', () => {
  it('installs a first release into slot a, initialising its database before its Odoo starts', async () => {
    const made = cluster(slotStateFrom(null));
    const { log } = made;
    await withWorker(made, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-1', taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [build('r1', 'one')], ...startedFor('bo') });
      expect(await handle.result()).toEqual({ r1: { state: 'live', slot: 'a' } });
    });
    expect(log).toEqual(['helm live=a a=- b=-', 'ready statefulset/shop-postgres', 'job shop-init-a', 'helm live=a a=one b=-', 'ready deployment/shop-odoo-a']);
    expect(made.gates).toEqual([]);
  }, 60_000);

  it('syncs the project\'s vault before a release is applied, and its jobs read the database password and set the admin\'s from it', async () => {
    const made = cluster(slotStateFrom(null));
    const vault = { projectId: 'p1', secret: 'shop-vault', keys: ['POSTGRES_PASSWORD', 'ODOO_ADMIN_PASSWORD'], database: { secret: 'shop-vault', key: 'POSTGRES_PASSWORD' }, adminKey: 'ODOO_ADMIN_PASSWORD' };
    await withWorker(made, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-vault', taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [{ ...build('r1', 'one'), vault }], ...startedFor('bo') });
      expect(await handle.result()).toEqual({ r1: { state: 'live', slot: 'a' } });
    });
    expect(made.log.slice(0, 2)).toEqual(['vault shop-vault POSTGRES_PASSWORD,ODOO_ADMIN_PASSWORD', 'helm live=a a=- b=-']);
    const init = made.jobs.find((entry) => entry.name === 'shop-init-a')!.manifest as { spec: { template: { spec: { containers: { command: string[]; env: { name: string; valueFrom?: { secretKeyRef: { name: string; key: string } } }[] }[] } } } };
    const container = init.spec.template.spec.containers[0]!;
    expect(container.command[0]).toBe('sh');
    expect(container.env.filter((entry) => entry.valueFrom).map((entry) => [entry.name, entry.valueFrom!.secretKeyRef.name, entry.valueFrom!.secretKeyRef.key]))
      .toEqual([['PASSWORD', 'shop-vault', 'POSTGRES_PASSWORD'], ['ADMIN_PASSWORD', 'shop-vault', 'ODOO_ADMIN_PASSWORD']]);
  }, 60_000);

  it('prepares the next build in the idle slot from a quieted copy of the live one, tests it in a browser, and cuts over when asked', async () => {
    const made = cluster(LIVE_A);
    const { log, values } = made;
    await withWorker(made, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-2', taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [build('r2', 'two')], ...startedFor('bo') });
      expect(await progressOf('release-2', 'r2', 'preview')).toMatchObject({ state: 'preview', slot: 'b' });
      expect(await e2eOf('release-2', 'r2', 'passed')).toEqual(PASSED);
      expect(values()).toMatchObject({ live: 'a', tags: { a: 'one', b: 'two' }, previewHost: 'shop-preview.apps.local' });
      await handle.signal('cutOver', 'r2');
      expect(await handle.result()).toEqual({ r2: { state: 'live', slot: 'b', e2e: PASSED } });
    });
    expect(made.gates).toEqual([{ target, source: { owner: 'bo', repo: 'shop', commit: 'two' }, ownerId: 'bo', releaseId: 'r2', slot: 'b', image: 'reg/bo/shop:two', minutes: 20 }]);
    expect(log).toEqual([
      'helm live=a a=one b=-', 'copy odoo_a>odoo_b', 'quiet odoo_b', 'job shop-filestore-b', 'job shop-upgrade-b', 'helm live=a a=one b=two preview', 'ready deployment/shop-odoo-b',
      'browser r2 slot b',
      'scale a=0', 'helm live=a a=one b=-', 'copy odoo_a>odoo_b', 'job shop-filestore-b', 'job shop-upgrade-b', 'helm live=b a=one b=two', 'scale a=0', 'ready deployment/shop-odoo-b',
    ]);
    expect(values()).toMatchObject({ live: 'b', tags: { a: 'one', b: 'two' } });
  }, 60_000);

  it('lets a newer build take the place of a waiting preview, stopping its browser tests, and discards one when asked', async () => {
    const made = cluster(LIVE_A, { gate: 'hold' });
    const { values } = made;
    await withWorker(made, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-3', taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [build('r3', 'three')], ...startedFor('bo') });
      await e2eOf('release-3', 'r3', 'running');
      await handle.signal('releaseBuild', build('r4', 'four'));
      await progressOf('release-3', 'r4', 'preview');
      expect(values().tags).toEqual({ a: 'one', b: 'four' });
      await handle.signal('discard', 'r4');
      expect(await handle.result()).toMatchObject({
        r3: { state: 'superseded', slot: 'b', reason: 'a newer build took its place', e2e: { state: 'stopped', reason: 'stopped before the tests finished' } },
        r4: { state: 'discarded', slot: 'b', e2e: { state: 'stopped' } },
      });
    });
    expect(made.log).toContain('browser r3 stopped');
    expect(values()).toMatchObject({ live: 'a', tags: { a: 'one', b: undefined } });
  }, 60_000);

  it('fails a build whose upgrade breaks while preparing, without touching the live slot', async () => {
    const made = cluster(LIVE_A, { failJob: 'shop-upgrade-b' });
    const { log } = made;
    await withWorker(made, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-4', taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [build('r5', 'five')], ...startedFor('bo') });
      const result = await handle.result();
      expect(result.r5).toMatchObject({ state: 'failed', reason: expect.stringContaining('Failed to load registry') });
    });
    expect(log).not.toContain('scale a=0');
    expect(made.gates).toEqual([]);
  }, 60_000);

  it('runs the browser tests again when asked, while the preview waits', async () => {
    const made = cluster(LIVE_A);
    await withWorker(made, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-6', taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [build('r7', 'seven')], ...startedFor('bo') });
      await e2eOf('release-6', 'r7', 'passed');
      await handle.signal('retest', 'r7');
      for (let tries = 0; tries < 200 && made.gates.length < 2; tries += 1) await new Promise((done) => setTimeout(done, 50));
      await e2eOf('release-6', 'r7', 'passed');
      await handle.signal('discard', 'r7');
      await handle.result();
    });
    expect(made.gates.map((gate) => gate.releaseId)).toEqual(['r7', 'r7']);
  }, 60_000);

  it('brings the live slot back up when a cutover fails, and says why', async () => {
    const made = cluster(LIVE_A, { failJob: 'shop-upgrade-b', failOnTry: 2 });
    const { log, values } = made;
    await withWorker(made, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-5', taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [build('r6', 'six')], ...startedFor('bo') });
      await progressOf('release-5', 'r6', 'preview');
      await handle.signal('cutOver', 'r6');
      expect((await handle.result()).r6).toMatchObject({ state: 'failed', reason: expect.stringContaining('Failed to load registry') });
    });
    expect(log.slice(-2)).toEqual(['job shop-filestore-b', 'scale a=1']);
    expect(log).toContain('scale a=0');
    expect(values().live).toBe('a');
  }, 60_000);

  it('goes back to the slot kept at the cutover: starts it, waits for it, then switches live to it and clears the newer one', async () => {
    const made = cluster({ installed: true, live: 'b', tags: { a: 'one', b: 'two' } });
    const { log, values } = made;
    await withWorker(made, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-back', taskQueue, args: [input], signal: 'rollBack', signalArgs: [{ from: 'r2', to: build('r1', 'one') }], ...startedFor('bo') });
      const result = await handle.result();
      expect(result.r2).toEqual({ state: 'rolled-back', reason: 'rolled back to the release of one' });
      expect(result.r1).toMatchObject({ state: 'live', slot: 'a', restoredAt: expect.any(String) });
    });
    expect(log).toEqual(['scale a=1', 'ready deployment/shop-odoo-a', 'helm live=a a=one b=-', 'ready deployment/shop-odoo-a']);
    expect(values()).toMatchObject({ live: 'a', tags: { a: 'one', b: undefined } });
  }, 60_000);

  it('refuses to go back once the kept slot holds something else, leaving the live release live and saying why', async () => {
    const made = cluster({ installed: true, live: 'b', tags: { a: 'three', b: 'two' } });
    await withWorker(made, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-back-gone', taskQueue, args: [input], signal: 'rollBack', signalArgs: [{ from: 'r2', to: build('r1', 'one') }], ...startedFor('bo') });
      expect(await handle.result()).toEqual({ r2: { state: 'live', reason: 'the rollback failed: slot a no longer holds the release of one' } });
    });
    expect(made.log).toEqual([]);
  }, 60_000);

  it('stops the kept slot again when it never comes up, and the live release stays live', async () => {
    const made = cluster({ installed: true, live: 'b', tags: { a: 'one', b: 'two' } });
    made.activities.OdooReleaseWaitActivity = async ({ workload }) => { throw new Error(`${workload} never became ready`); };
    await withWorker(made, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-back-fails', taskQueue, args: [input], signal: 'rollBack', signalArgs: [{ from: 'r2', to: build('r1', 'one') }], ...startedFor('bo') });
      expect((await handle.result()).r2).toMatchObject({ state: 'live', reason: expect.stringContaining('the rollback failed') });
    });
    expect(made.log).toEqual(['scale a=1', 'scale a=0']);
    expect(made.values()).toMatchObject({ live: 'b', tags: { a: 'one', b: 'two' } });
  }, 60_000);
});
