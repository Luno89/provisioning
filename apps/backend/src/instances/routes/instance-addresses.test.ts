import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { callRouter, PERSON } from '../testing/call-router.js';
import { instanceAddressesRouter } from './instance-addresses.js';
import type { AddressesView, InstanceAddresses } from '../services/InstanceAddresses.js';

const containing = (text: string): unknown => expect.stringContaining(text);

type Addresses = Pick<InstanceAddresses, 'refresh' | 'set'>;

const view: AddressesView = { nested: true, state: 'issuing', name: 'luno', domain: 'koala.dev' };
const ownedBy = (id: string) => ({ role: 'instance' as const, instanceOwnerId: id });

describe('the instance\'s addresses route', () => {
  it('reads and sets them through the instance\'s own addresses', async () => {
    const addresses = mock<Addresses>();
    addresses.refresh.mockResolvedValue(view);
    addresses.set.calledWith(true).mockResolvedValue(view);
    const router = instanceAddressesRouter({ addresses: () => addresses });
    expect((await callRouter(router, '/api/instance-addresses', { path: '/', claims: ownedBy(PERSON.id) })).body).toEqual(view);
    expect((await callRouter(router, '/api/instance-addresses', { method: 'PUT', path: '/', body: { nested: true }, claims: ownedBy(PERSON.id) })).body).toEqual(view);
    expect(addresses.set).toHaveBeenCalledWith(true);
  });

  it('asks for true or false, and sets nothing otherwise', async () => {
    const addresses = mock<Addresses>();
    const router = instanceAddressesRouter({ addresses: () => addresses });
    for (const body of [{ nested: 'yes' }, {}, undefined]) {
      const refused = await callRouter(router, '/api/instance-addresses', { method: 'PUT', path: '/', ...(body ? { body } : {}), claims: ownedBy(PERSON.id) });
      expect([refused.status, refused.body]).toEqual([400, { error: 'send "nested" as true or false' }]);
    }
    expect(addresses.set).not.toHaveBeenCalled();
  });

  it('lets only the instance\'s owner change them', async () => {
    const addresses = mock<Addresses>();
    const refused = await callRouter(instanceAddressesRouter({ addresses: () => addresses }), '/api/instance-addresses', { method: 'PUT', path: '/', body: { nested: true }, claims: ownedBy('the-owner') });
    expect([refused.status, refused.body]).toEqual([403, { error: 'Only the owner of this instance changes its settings.' }]);
    expect(addresses.set).not.toHaveBeenCalled();
  });

  it('says so on an instance with no addresses', async () => {
    const router = instanceAddressesRouter({ addresses: () => undefined });
    const read = await callRouter(router, '/api/instance-addresses', { path: '/', claims: ownedBy(PERSON.id) });
    expect(read.status).toBe(404);
    expect(read.body).toEqual({ error: containing('no addresses of its own') });
    expect((await callRouter(router, '/api/instance-addresses', { method: 'PUT', path: '/', body: { nested: true }, claims: ownedBy(PERSON.id) })).status).toBe(404);
  });
});
