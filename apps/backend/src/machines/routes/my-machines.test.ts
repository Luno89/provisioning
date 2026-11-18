import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { routesInProcess } from '../../platform/testing/routes.js';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import { myMachinesRouter } from './my-machines.js';

type Accounts = Pick<MachineAccounts, 'mine' | 'createJoinCode' | 'putKoalaOn' | 'remove' | 'dismissJoin'>;
let accounts: ReturnType<typeof mock<Accounts>>;

const routes = () => routesInProcess({ prefix: '/api/my-machines', router: () => myMachinesRouter({ accounts, koalaOf: async (owner) => (owner === 'test-user' ? { machineId: 'desk', status: 'ready' } : undefined) }) });

beforeEach(() => {
  accounts = mock<Accounts>();
});

describe('/api/my-machines on root', () => {
  it('lists the person\'s machines with which one holds their Koala, and their joins', async () => {
    const join = { id: 'j1', stage: 'k3s', title: 'Installing k3s', state: 'failed' as const, why: 'no space left', at: 't', expiresAt: 't' };
    accounts.mine.mockResolvedValue({ machines: [{ id: 'desk', ownerId: 'test-user', name: 'desk', rootDir: '/x', createdAt: 't', online: true, koalaWanted: false }], joins: [join] });
    const answer = await (await routes()).get('/api/my-machines');
    expect(answer.data).toEqual({ machines: [expect.objectContaining({ id: 'desk', online: true, holdsKoala: true })], joins: [join], koala: { machineId: 'desk', status: 'ready' } });
    expect(accounts.mine).toHaveBeenCalledWith('test-user');
  });

  it('dismisses a join of the person\'s, saying why it cannot', async () => {
    accounts.dismissJoin.mockResolvedValueOnce({ ok: true, value: { dismissed: true } }).mockResolvedValueOnce({ ok: false, status: 409, error: 'that machine is still joining; it can be dismissed once it fails or its command expires' });
    const site = await routes();
    expect(await site.request('DELETE', '/api/my-machines/joins/j1')).toMatchObject({ status: 200, data: { dismissed: true } });
    expect(accounts.dismissJoin).toHaveBeenCalledWith('test-user', 'j1');
    expect(await site.request('DELETE', '/api/my-machines/joins/j2')).toMatchObject({ status: 409, data: { error: 'that machine is still joining; it can be dismissed once it fails or its command expires' } });
  });

  it('makes a join command, asking for Koala on the machine when a name is given', async () => {
    accounts.createJoinCode.mockResolvedValue({ code: 'c', command: 'curl', expiresAt: 't' });
    const site = await routes();
    expect((await site.post('/api/my-machines/join-code', { koalaName: 'bobby' })).status).toBe(201);
    expect(accounts.createJoinCode).toHaveBeenCalledWith('test-user', 'bobby');
    await site.post('/api/my-machines/join-code', {});
    expect(accounts.createJoinCode).toHaveBeenLastCalledWith('test-user', undefined);
  });

  it('puts Koala on a machine of the person\'s, saying why it cannot', async () => {
    accounts.putKoalaOn.mockResolvedValueOnce({ ok: true, value: { placing: true } }).mockResolvedValueOnce({ ok: false, status: 404, error: 'no such machine on your account' });
    const site = await routes();
    expect(await site.post('/api/my-machines/desk/koala', { name: 'bobby' })).toMatchObject({ status: 202, data: { placing: true } });
    expect(accounts.putKoalaOn).toHaveBeenCalledWith('test-user', 'desk', 'bobby');
    expect(await site.post('/api/my-machines/nope/koala', {})).toMatchObject({ status: 404, data: { error: 'no such machine on your account' } });
  });

  it('removes a machine of the person\'s', async () => {
    accounts.remove.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const site = await routes();
    expect((await site.request('DELETE', '/api/my-machines/desk')).status).toBe(200);
    expect((await site.request('DELETE', '/api/my-machines/nope')).status).toBe(404);
  });
});
