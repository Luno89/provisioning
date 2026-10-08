import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { temporalTestEnvironment } from './temporal-test-env.js';
import { startedFor } from '../lib/workflow-owner.js';
import { slotStateFrom, type SlotState } from '../lib/odoo-release.js';
import type { OdooReleaseActivities, ReleaseTarget } from '../activities/OdooReleaseActivities.js';
import type { ReleaseBuild, ReleaseProgress } from './OdooReleaseWorkflow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await temporalTestEnvironment(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

const target: ReleaseTarget = { clusterName: 'dev', provider: 'k3d', namespace: 'shop', release: 'shop' };
const input = { target, host: 'shop.apps.local', previewHost: 'shop-preview.apps.local' };
const build = (id: string, tag: string): ReleaseBuild => ({ releaseId: id, image: `reg/bo/shop:${tag}`, source: { owner: 'bo', repo: 'shop', commit: tag } });

function cluster(start: SlotState, options: { failJob?: string; failOnTry?: number } = {}) {
  let values: SlotState = start;
  const log: string[] = [];
  const tries = new Map<string, number>();
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
    OdooReleaseJobActivity: async ({ name }) => {
      tries.set(name, (tries.get(name) ?? 0) + 1);
      if (name === options.failJob && tries.get(name) === (options.failOnTry ?? 1)) throw new Error(`${name} failed: odoo.modules.registry: Failed to load registry`);
      log.push(`job ${name}`);
    },
    OdooReleaseScaleActivity: async ({ slot, replicas }) => { log.push(`scale ${slot}=${replicas}`); },
  };
  return { activities, log, values: () => values };
}

async function withWorker(activities: OdooReleaseActivities, body: (queue: string) => Promise<void>) {
  const taskQueue = `odoo-release-test-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: resolve(__dirname, 'index.ts'), activities });
  await worker.runUntil(() => body(taskQueue));
}

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
    const { activities, log } = cluster(slotStateFrom(null));
    await withWorker(activities, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-1', taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [build('r1', 'one')], ...startedFor('bo') });
      expect(await handle.result()).toEqual({ r1: { state: 'live', slot: 'a' } });
    });
    expect(log).toEqual(['helm live=a a=- b=-', 'ready statefulset/shop-postgres', 'job shop-init-a', 'helm live=a a=one b=-', 'ready deployment/shop-odoo-a']);
  }, 60_000);

  it('prepares the next build in the idle slot from a copy of the live one, previews it, and cuts over when asked', async () => {
    const { activities, log, values } = cluster(LIVE_A);
    await withWorker(activities, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-2', taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [build('r2', 'two')], ...startedFor('bo') });
      expect(await progressOf('release-2', 'r2', 'preview')).toEqual({ state: 'preview', slot: 'b' });
      expect(values()).toMatchObject({ live: 'a', tags: { a: 'one', b: 'two' }, previewHost: 'shop-preview.apps.local' });
      await handle.signal('cutOver', 'r2');
      expect(await handle.result()).toEqual({ r2: { state: 'live', slot: 'b' } });
    });
    expect(log).toEqual([
      'helm live=a a=one b=-', 'copy odoo_a>odoo_b', 'job shop-filestore-b', 'job shop-upgrade-b', 'helm live=a a=one b=two preview', 'ready deployment/shop-odoo-b',
      'scale a=0', 'helm live=a a=one b=-', 'copy odoo_a>odoo_b', 'job shop-filestore-b', 'job shop-upgrade-b', 'helm live=b a=one b=two', 'ready deployment/shop-odoo-b',
    ]);
    expect(values()).toMatchObject({ live: 'b', tags: { a: 'one', b: 'two' } });
  }, 60_000);

  it('lets a newer build take the place of a waiting preview, and discards one when asked', async () => {
    const { activities, values } = cluster(LIVE_A);
    await withWorker(activities, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-3', taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [build('r3', 'three')], ...startedFor('bo') });
      await progressOf('release-3', 'r3', 'preview');
      await handle.signal('releaseBuild', build('r4', 'four'));
      await progressOf('release-3', 'r4', 'preview');
      expect(values().tags).toEqual({ a: 'one', b: 'four' });
      await handle.signal('discard', 'r4');
      expect(await handle.result()).toEqual({
        r3: { state: 'superseded', slot: 'b', reason: 'a newer build took its place' },
        r4: { state: 'discarded', slot: 'b' },
      });
    });
    expect(values()).toMatchObject({ live: 'a', tags: { a: 'one', b: undefined } });
  }, 60_000);

  it('fails a build whose upgrade breaks while preparing, without touching the live slot', async () => {
    const { activities, log } = cluster(LIVE_A, { failJob: 'shop-upgrade-b' });
    await withWorker(activities, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-4', taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [build('r5', 'five')], ...startedFor('bo') });
      const result = await handle.result();
      expect(result.r5).toMatchObject({ state: 'failed', reason: expect.stringContaining('Failed to load registry') });
    });
    expect(log).not.toContain('scale a=0');
  }, 60_000);

  it('brings the live slot back up when a cutover fails, and says why', async () => {
    const { activities, log, values } = cluster(LIVE_A, { failJob: 'shop-upgrade-b', failOnTry: 2 });
    await withWorker(activities, async (taskQueue) => {
      const handle = await env.client.workflow.signalWithStart('OdooReleaseWorkflow', { workflowId: 'release-5', taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [build('r6', 'six')], ...startedFor('bo') });
      await progressOf('release-5', 'r6', 'preview');
      await handle.signal('cutOver', 'r6');
      expect((await handle.result()).r6).toMatchObject({ state: 'failed', reason: expect.stringContaining('Failed to load registry') });
    });
    expect(log.slice(-2)).toEqual(['job shop-filestore-b', 'scale a=1']);
    expect(log).toContain('scale a=0');
    expect(values().live).toBe('a');
  }, 60_000);
});
