import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { instanceAddressesRouter } from './instance-addresses.js';
import { InstanceAddresses } from '../services/InstanceAddresses.js';
import { rootWithAnInstance, type RootWithAnInstance } from '../testing/root-with-an-instance.js';

let harness: Harness | undefined;
let root: RootWithAnInstance | undefined;
let addresses: InstanceAddresses | undefined;
afterEach(async () => {
  addresses?.stop();
  await harness?.close();
  await root?.close();
  harness = undefined;
  root = undefined;
  addresses = undefined;
});

const instanceAsking = async (instanceOwnerId: string): Promise<Harness> => {
  root = await rootWithAnInstance();
  addresses = new InstanceAddresses({ ...root.instance, name: 'luno' }, async () => undefined);
  const reached = addresses;
  return mountRouter({ db: 'own', prefix: '/api/instance-addresses', claims: { role: 'instance', instanceOwnerId }, router: () => instanceAddressesRouter({ addresses: () => reached }) });
};

describe('the instance\'s addresses route', () => {
  it('reads and sets them through the instance\'s own addresses', async () => {
    harness = await instanceAsking(TEST_USER.id);
    expect((await axios.get(harness.url('/api/instance-addresses'))).data).toEqual({ nested: false, name: 'luno', domain: 'koala.dev' });
    const issuing = { nested: true, state: 'issuing', name: 'luno', domain: 'koala.dev' };
    expect((await axios.put(harness.url('/api/instance-addresses'), { nested: true })).data).toEqual(issuing);
    expect((await root!.record()).addresses).toMatchObject({ nested: true, state: 'issuing' });
    expect((await axios.get(harness.url('/api/instance-addresses'))).data).toEqual(issuing);
    expect((await axios.put(harness.url('/api/instance-addresses'), { nested: 'yes' }, { validateStatus: () => true })).status).toBe(400);
    expect((await root!.record()).addresses).toMatchObject({ nested: true, state: 'issuing' });
  });

  it('lets only the instance\'s owner change them', async () => {
    harness = await instanceAsking('the-owner');
    const refused = await axios.put<{ error?: string }>(harness.url('/api/instance-addresses'), { nested: true }, { validateStatus: () => true });
    expect([refused.status, refused.data.error]).toEqual([403, 'Only the owner of this instance changes its settings.']);
    expect((await root!.record()).addresses?.nested ?? false).toBe(false);
  });

  it('answers none on an instance with no addresses', async () => {
    harness = await mountRouter({ prefix: '/api/instance-addresses', claims: { role: 'instance', instanceOwnerId: TEST_USER.id }, router: () => instanceAddressesRouter({ addresses: () => undefined }) });
    const answer = await axios.get(harness.url('/api/instance-addresses'), { validateStatus: () => true });
    expect([answer.status, answer.data]).toEqual([200, null]);
  });
});
