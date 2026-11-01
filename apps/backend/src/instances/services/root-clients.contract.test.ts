import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { instancesRouter } from '../routes/instances.js';
import { InstanceService } from './InstanceService.js';
import { InstanceGroups } from './InstanceGroups.js';
import { InstanceWatchSetting } from './InstanceWatchSetting.js';
import { InstanceUpdates } from './InstanceUpdates.js';
import { InstanceTrial } from './InstanceTrial.js';
import { RootMeshKeys } from './RootMeshKeys.js';

let harness: Harness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

async function rootWithAnInstance() {
  let service: InstanceService | undefined;
  const meshAsked: string[] = [];
  const settings = {
    rootUrl: '', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 'new222', domain: 'koala.dev', meshLoginServer: 'https://mesh.koala.dev',
    releases: { hasChart: () => false, releases: async () => [
      { imageTag: 'old111', version: 'v2026.10.29', servedAt: '2026-10-29T00:00:00Z' },
      { imageTag: 'new222', version: 'v2026.10.30', servedAt: '2026-10-30T00:00:00Z' },
    ] },
  };
  harness = await mountRouter({
    prefix: '/api/instances',
    router: (db) => {
      service = new InstanceService(db, settings, {
        createPreAuthKey: async (ownerId) => { meshAsked.push(`key for ${ownerId}`); return { key: `key-of-${ownerId}` }; },
        listUserDevices: async () => [{ ipAddresses: ['100.64.0.9'] }],
        removeNode: async (ownerId, meshIp) => { meshAsked.push(`remove ${meshIp} of ${ownerId}`); },
      });
      return instancesRouter({ instances: service, chart: async () => '', operatorOnly: (_req: Request, _res: Response, next: NextFunction) => next() });
    },
  });
  settings.rootUrl = harness.url('');
  const made = await service!.createJoinToken(TEST_USER.id, 'luno');
  if (!made.ok) throw new Error(made.error);
  const joined = await service!.join(made.value.token, 'box');
  if (!joined.ok) throw new Error(joined.error);
  await service!.report(joined.value.instanceId, joined.value.credential, { status: 'ready', detail: 'Installed', imageTag: 'old111', meshIp: '100.64.0.9', presence: true });
  const instance = { rootUrl: harness.url(''), instanceId: joined.value.instanceId, token: async () => joined.value.credential };
  return { instance, meshAsked, record: async () => (await harness!.db.instances.getInstances()).find((entry) => entry.id === joined.value.instanceId)! };
}

describe('an instance\'s clients against root\'s own routes', () => {
  it('claims, checks and frees a group, and root keeps exactly what the instance holds', async () => {
    const { instance, record } = await rootWithAnInstance();
    const groups = new InstanceGroups(instance);
    expect(await groups.check('acme')).toBeNull();
    expect(await groups.check('no-dashes')).not.toBeNull();
    await groups.claim('p1', 'acme');
    expect((await record()).groups).toEqual([{ projectId: 'p1', name: 'acme' }]);
    await groups.release('p1');
    expect((await record()).groups ?? []).toEqual([]);
  });

  it('reads and switches whether root emails the owner when the instance is gone', async () => {
    const { instance } = await rootWithAnInstance();
    const watch = new InstanceWatchSetting(instance);
    expect(await watch.read()).toMatchObject({ notifyWhenUnreachable: true, alwaysTold: false });
    expect(await watch.set(false)).toMatchObject({ notifyWhenUnreachable: false });
    expect(await watch.read()).toMatchObject({ notifyWhenUnreachable: false });
  });

  it('reads what root offers, turns automatic updates off, and starts a check-in once it picks a release', async () => {
    const { instance, record } = await rootWithAnInstance();
    const started: string[][] = [];
    const kubectl = async (args: string[]) => {
      started.push(args);
      if (args[0] === 'get' && args[1] === 'jobs') return JSON.stringify({ items: [] });
      if (args[0] === 'create' && args[1] === 'job') return '';
      throw new Error(`kubectl was asked ${args.join(' ')}, which the test does not answer`);
    };
    const updates = new InstanceUpdates({ ...instance, cronJob: 'instance-self-upgrade', namespace: 'nowrinkles' }, kubectl);
    const offered = await updates.view();
    expect(offered).toMatchObject({ auto: true, running: 'old111', target: 'new222' });
    await updates.set({ auto: false });
    expect((await record()).updates).toMatchObject({ auto: false });
    await updates.set({ version: 'v2026.10.30' });
    expect((await record()).updates).toMatchObject({ auto: false, picked: 'new222' });
    expect(started.some((args) => args.includes('create') && args.includes('job'))).toBe(true);
  });

  it('reads no trial for an instance on a person\'s machine, and root\'s refusal of a wrong credential', async () => {
    const { instance } = await rootWithAnInstance();
    expect(await new InstanceTrial(instance).read()).not.toHaveProperty('trialEndsAt');
    await expect(new InstanceTrial({ ...instance, token: async () => 'not-the-credential' }).read()).rejects.toThrow('root did not answer about this instance\'s trial (401): unknown instance or credential');
  });

  it('gets a key for a machine to join its owner\'s mesh, and takes a machine off it, never the instance itself', async () => {
    const { instance, meshAsked } = await rootWithAnInstance();
    const keys = new RootMeshKeys(instance);
    expect(await keys.createPreAuthKey('ignored')).toEqual({ key: `key-of-${TEST_USER.id}` });
    await keys.removeNode('ignored', '100.64.0.20');
    await expect(keys.removeNode('ignored', '100.64.0.9')).rejects.toThrow('root would not take the machine off the mesh (400): that is the instance itself, not one of its machines');
    expect(meshAsked).toEqual([`key for ${TEST_USER.id}`, `key for ${TEST_USER.id}`, `remove 100.64.0.20 of ${TEST_USER.id}`]);
  });
});
