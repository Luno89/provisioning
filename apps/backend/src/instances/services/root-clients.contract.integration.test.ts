import { afterEach, describe, expect, it } from 'vitest';
import { rootWithAnInstance as openRoot, type RootWithAnInstance } from '../testing/root-with-an-instance.js';
import { InstanceGroups } from './InstanceGroups.js';
import { InstanceWatchSetting } from './InstanceWatchSetting.js';
import { InstanceUpdates } from './InstanceUpdates.js';
import { InstanceAddresses } from './InstanceAddresses.js';

const roots: RootWithAnInstance[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => root.close())); });

const rootWithAnInstance = async (): Promise<RootWithAnInstance> => {
  const root = await openRoot();
  roots.push(root);
  return root;
};

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
    expect(await watch.read()).toMatchObject({ notifyWhenUnreachable: true });
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

  it('reads and switches nested addresses through root, republishing the apps only when they become ready or stop, and asking again while they are issued', async () => {
    const { instance, harness, record } = await rootWithAnInstance();
    let republished = 0;
    let firstRepublish!: () => void;
    const republishedOnce = new Promise<void>((done) => { firstRepublish = done; });
    const addresses = new InstanceAddresses({ ...instance, name: 'luno' }, async () => { republished += 1; firstRepublish(); }, undefined, 25);
    try {
      expect(await addresses.refresh()).toMatchObject({ nested: false, name: 'luno', domain: 'koala.dev' });
      expect(addresses.nestedReady()).toBe(false);
      expect(await addresses.set(true)).toMatchObject({ nested: true, state: 'issuing' });
      expect(republished).toBe(0);
      await harness.db.instances.saveInstance({ ...(await record()), addresses: { nested: true, state: 'ready' } });
      await republishedOnce;
      expect(addresses.nestedReady()).toBe(true);
      expect(republished).toBe(1);
      expect(await addresses.set(false)).toMatchObject({ nested: false });
      expect(addresses.nestedReady()).toBe(false);
      expect(republished).toBe(2);
    } finally {
      addresses.stop();
    }
  });

  it('says what root said when it will not answer about addresses', async () => {
    const { instance } = await rootWithAnInstance();
    const addresses = new InstanceAddresses({ ...instance, name: 'box', token: async () => 'not-the-credential' }, async () => undefined);
    await expect(addresses.refresh()).rejects.toThrow('root did not answer about this instance\'s addresses (401): unknown instance or credential');
  });
});
