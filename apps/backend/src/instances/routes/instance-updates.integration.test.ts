import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { rootWithAnInstance, type RootWithAnInstance } from '../testing/root-with-an-instance.js';
import { InstanceUpdates } from '../services/InstanceUpdates.js';
import { instanceUpdatesRouter } from './instance-updates.js';

const prefix = '/api/instance-updates';
const quiet = { validateStatus: () => true };

const opened: Array<Harness | RootWithAnInstance> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((entry) => entry.close())); });

async function instanceOn(root: RootWithAnInstance, owner = TEST_USER.id, token?: () => Promise<string>) {
  opened.push(root);
  const kubectl: string[][] = [];
  const updates = new InstanceUpdates({ ...root.instance, ...(token ? { token } : {}), cronJob: 'instance-self-upgrade', namespace: 'nowrinkles' }, async (args) => {
    kubectl.push(args);
    return args[0] === 'get' ? JSON.stringify({ items: [] }) : '';
  });
  const harness = await mountRouter({ prefix, claims: { role: 'instance', instanceOwnerId: owner }, router: () => instanceUpdatesRouter({ updates }) });
  opened.push(harness);
  return { harness, kubectl };
}

describe('an instance\'s updates route, asking root over HTTP', () => {
  it('shows the updates root keeps for the instance, and what the release it runs carries', async () => {
    const { harness } = await instanceOn(await rootWithAnInstance());
    expect((await axios.get(harness.url(prefix))).data).toMatchObject({ auto: true, running: 'old111', target: 'new222' });
    expect((await axios.get(harness.url(`${prefix}/findings`))).data).toEqual({ findings: [] });
  });

  it('sets what the owner asks for, root keeping it, and starts a check-in when the change moves the instance', async () => {
    const root = await rootWithAnInstance();
    const { harness, kubectl } = await instanceOn(root);
    expect((await axios.put(harness.url(prefix), { auto: false })).data).toMatchObject({ auto: false });
    expect((await root.record()).updates).toMatchObject({ auto: false });
    const picked = await axios.put(harness.url(prefix), { version: 'v2026.10.30' });
    expect(picked.data).toMatchObject({ target: 'new222' });
    expect((picked.data as { checking: string }).checking).toMatch(/^instance-self-upgrade-/);
    expect(kubectl.some((args) => args[0] === 'create' && args[1] === 'job')).toBe(true);
  });

  it('refuses a change that is not true or false, or a release name, before root is asked', async () => {
    const root = await rootWithAnInstance();
    const { harness } = await instanceOn(root);
    const badAuto = await axios.put(harness.url(prefix), { auto: 'yes' }, quiet);
    const badVersion = await axios.put(harness.url(prefix), { version: 2 }, quiet);
    expect([badAuto.status, badAuto.data]).toEqual([400, { error: 'send "auto" as true or false' }]);
    expect([badVersion.status, badVersion.data]).toEqual([400, { error: 'send "version" as the release to move to' }]);
    expect((await root.record()).updates).toBeUndefined();
  });

  it('passes root\'s refusal on with its words, and turns its refusal of the instance\'s own credential into a bad gateway', async () => {
    const { harness } = await instanceOn(await rootWithAnInstance());
    const refused = await axios.put(harness.url(prefix), { version: 'v1999.01.01' }, quiet);
    expect([refused.status, refused.data]).toEqual([409, { error: 'there is no release v1999.01.01' }]);

    const wrong = await instanceOn(await rootWithAnInstance(), TEST_USER.id, async () => 'not-the-credential');
    expect((await axios.get(wrong.harness.url(prefix), quiet)).status).toBe(502);
    expect((await axios.get(wrong.harness.url(`${prefix}/findings`), quiet)).status).toBe(502);
  });

  it('lets only the owner change them', async () => {
    const root = await rootWithAnInstance();
    const { harness } = await instanceOn(root, 'the-owner');
    const refused = await axios.put(harness.url(prefix), { auto: false }, quiet);
    expect(refused.status).toBe(403);
    expect((await root.record()).updates).toBeUndefined();
  });
});
