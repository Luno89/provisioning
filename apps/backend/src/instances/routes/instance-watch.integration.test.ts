import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { rootWithAnInstance, type RootWithAnInstance } from '../testing/root-with-an-instance.js';
import { instanceWatchRouter } from './instance-watch.js';
import { InstanceWatchSetting } from '../services/InstanceWatchSetting.js';

const opened: Array<Harness | RootWithAnInstance> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((entry) => entry.close())); });

const prefix = '/api/instance-watch';

async function instanceOn(setting: InstanceWatchSetting | undefined, owner = TEST_USER.id): Promise<Harness> {
  const harness = await mountRouter({ prefix, claims: { role: 'instance', instanceOwnerId: owner }, router: () => instanceWatchRouter({ setting }) });
  opened.push(harness);
  return harness;
}

async function aRoot(options: { pool?: boolean } = {}): Promise<RootWithAnInstance> {
  const root = await rootWithAnInstance(options);
  opened.push(root);
  return root;
}

const recording = (asked: string[]): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
  asked.push(`${init?.method ?? 'GET'} ${String(url)} ${(init?.headers as Record<string, string>).authorization}`);
  return fetch(url, init);
}) as typeof fetch;

describe('whether root emails the instance\'s owner when it cannot be reached', () => {
  it('is read from root and switched only by the instance\'s owner', async () => {
    const root = await aRoot();
    const asked: string[] = [];
    const setting = new InstanceWatchSetting(root.instance, recording(asked));
    const harness = await instanceOn(setting);
    expect((await axios.get(harness.url(prefix))).data).toEqual({ notifyWhenUnreachable: true, alwaysTold: false });
    expect((await axios.put(harness.url(prefix), { notifyWhenUnreachable: false })).data).toEqual({ notifyWhenUnreachable: false, alwaysTold: false });
    expect((await axios.put(harness.url(prefix), { notifyWhenUnreachable: 'no' }, { validateStatus: () => true })).status).toBe(400);
    const credential = await root.instance.token();
    expect(asked).toEqual([
      `GET ${root.instance.rootUrl}/api/instances/watch Bearer ${credential}`,
      `PUT ${root.instance.rootUrl}/api/instances/watch Bearer ${credential}`,
    ]);
    expect(await root.harness.db.instances.getWatch(root.instance.instanceId)).toMatchObject({ notifyWhenUnreachable: false });

    const notTheOwners = await instanceOn(setting, 'someone-else');
    expect((await axios.put(notTheOwners.url(prefix), { notifyWhenUnreachable: true }, { validateStatus: () => true })).status).toBe(403);
    expect(asked).toHaveLength(2);
    expect(await root.harness.db.instances.getWatch(root.instance.instanceId)).toMatchObject({ notifyWhenUnreachable: false });
  });

  it('passes root\'s refusal on, and says so where nothing is watched', async () => {
    const root = await aRoot({ pool: true });
    const harness = await instanceOn(new InstanceWatchSetting(root.instance));
    const refused = await axios.put<{ error?: string }>(harness.url(prefix), { notifyWhenUnreachable: false }, { validateStatus: () => true });
    expect([refused.status, refused.data.error]).toEqual([409, 'an instance on Koala\'s servers always tells its owner when it cannot be reached']);
    const stranger = await instanceOn(new InstanceWatchSetting({ ...root.instance, token: async () => 'not-its-credential' }));
    const unknown = await axios.get<{ error?: string }>(stranger.url(prefix), { validateStatus: () => true });
    expect([unknown.status, unknown.data.error]).toEqual([401, 'unknown instance or credential']);
    const nothing = await mountRouter({ prefix, router: () => instanceWatchRouter({ setting: undefined }) });
    opened.push(nothing);
    expect((await axios.get(nothing.url(prefix), { validateStatus: () => true })).status).toBe(404);
  });
});
