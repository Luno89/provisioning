import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Router } from 'express';
import type { ClaimSettings } from '../../platform/lib/permissions.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import { instanceAddressesRouter } from './instance-addresses.js';
import type { AddressesView, InstanceAddresses } from '../services/InstanceAddresses.js';

const containing = (text: string): unknown => expect.stringContaining(text);

type Addresses = Pick<InstanceAddresses, 'refresh' | 'set'>;

const view: AddressesView = { nested: true, state: 'issuing', name: 'luno', domain: 'koala.dev' };
const ownedBy = (id: string) => ({ role: 'instance' as const, instanceOwnerId: id });
const on = (router: Router, claims: ClaimSettings) => routesInProcess({ prefix: '/api/instance-addresses', router: () => router, user: PERSON, claims });

describe('the instance\'s addresses route', () => {
  it('reads and sets them through the instance\'s own addresses', async () => {
    const addresses = mock<Addresses>();
    addresses.refresh.mockResolvedValue(view);
    addresses.set.calledWith(true).mockResolvedValue(view);
    const router = instanceAddressesRouter({ addresses: () => addresses });
    expect((await (await on(router, ownedBy(PERSON.id))).get('/api/instance-addresses')).data).toEqual(view);
    expect((await (await on(router, ownedBy(PERSON.id))).put('/api/instance-addresses', { nested: true })).data).toEqual(view);
    expect(addresses.set).toHaveBeenCalledWith(true);
  });

  it('asks for true or false, and sets nothing otherwise', async () => {
    const addresses = mock<Addresses>();
    const router = instanceAddressesRouter({ addresses: () => addresses });
    for (const body of [{ nested: 'yes' }, {}, undefined]) {
      const refused = await (await on(router, ownedBy(PERSON.id))).put('/api/instance-addresses', body);
      expect([refused.status, refused.data]).toEqual([400, { error: 'send "nested" as true or false' }]);
    }
    expect(addresses.set).not.toHaveBeenCalled();
  });

  it('lets only the instance\'s owner change them', async () => {
    const addresses = mock<Addresses>();
    const refused = await (await on(instanceAddressesRouter({ addresses: () => addresses }), ownedBy('the-owner'))).put('/api/instance-addresses', { nested: true });
    expect([refused.status, refused.data]).toEqual([403, { error: 'Only the owner of this instance changes its settings.' }]);
    expect(addresses.set).not.toHaveBeenCalled();
  });

  it('says so on an instance with no addresses', async () => {
    const router = instanceAddressesRouter({ addresses: () => undefined });
    const read = await (await on(router, ownedBy(PERSON.id))).get('/api/instance-addresses');
    expect(read.status).toBe(404);
    expect(read.data).toEqual({ error: containing('no addresses of its own') });
    expect((await (await on(router, ownedBy(PERSON.id))).put('/api/instance-addresses', { nested: true })).status).toBe(404);
  });
});
