import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { instanceAddressesRouter } from './instance-addresses.js';

let harness: Harness | undefined;
afterEach(async () => harness?.close());

const view = { nested: true, state: 'issuing', name: 'luno', domain: 'koala.dev' };

describe('the instance\'s addresses route', () => {
  it('reads and sets them through the instance\'s own addresses', async () => {
    const set: boolean[] = [];
    harness = await mountRouter({ prefix: '/api/instance-addresses', claims: { role: 'instance', instanceOwnerId: TEST_USER.id }, router: () => instanceAddressesRouter({ addresses: () => ({ refresh: async () => view as never, set: async (nested: boolean) => { set.push(nested); return view as never; } }) }) });
    expect((await axios.get(harness.url('/api/instance-addresses'))).data).toEqual(view);
    expect((await axios.put(harness.url('/api/instance-addresses'), { nested: true })).data).toEqual(view);
    expect(set).toEqual([true]);
    expect((await axios.put(harness.url('/api/instance-addresses'), { nested: 'yes' }, { validateStatus: () => true })).status).toBe(400);
  });

  it('lets only the instance\'s owner change them', async () => {
    const set: boolean[] = [];
    harness = await mountRouter({ prefix: '/api/instance-addresses', claims: { role: 'instance', instanceOwnerId: 'the-owner' }, router: () => instanceAddressesRouter({ addresses: () => ({ refresh: async () => ({}) as never, set: async (nested: boolean) => { set.push(nested); return {} as never; } }) }) });
    const refused = await axios.put(harness.url('/api/instance-addresses'), { nested: true }, { validateStatus: () => true });
    expect([refused.status, refused.data.error]).toEqual([403, 'Only the owner of this instance changes its settings.']);
    expect(set).toEqual([]);
  });

  it('says so on an instance with no addresses', async () => {
    harness = await mountRouter({ prefix: '/api/instance-addresses', claims: { role: 'instance', instanceOwnerId: TEST_USER.id }, router: () => instanceAddressesRouter({ addresses: () => undefined }) });
    const answer = await axios.get(harness.url('/api/instance-addresses'), { validateStatus: () => true });
    expect(answer.status).toBe(404);
    expect(answer.data.error).toMatch(/no addresses of its own/);
  });
});
