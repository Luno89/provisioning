import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { routesInProcess } from '../../platform/testing/routes.js';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import { accountMachinesRouter } from './account-machines.js';

const accounts = mock<Pick<MachineAccounts, 'list' | 'createJoinCode' | 'remove' | 'adoptFrom'>>();
const on = () => routesInProcess({
  prefix: '/api/instances/machines',
  user: null,
  open: true,
  router: () => accountMachinesRouter({ accounts, callerOf: async (req) => (req.headers.authorization === 'Bearer right' ? { ownerId: 'bo' } : undefined) }),
});
const as = (token: string) => ({ headers: { authorization: `Bearer ${token}`, 'x-instance-id': 'inst-1' } });

describe('/api/instances/machines, root answering an instance about its owner\'s machines', () => {
  it('lists, makes a command and removes, each for the instance\'s owner only', async () => {
    accounts.list.calledWith('bo').mockResolvedValue([{ id: 'm', ownerId: 'bo', name: 'desk', rootDir: '/x', createdAt: 'then' }]);
    accounts.createJoinCode.calledWith('bo').mockResolvedValue({ code: 'c', command: 'curl', expiresAt: 'then' });
    accounts.remove.calledWith('bo', 'm').mockResolvedValue(true);
    accounts.remove.calledWith('bo', 'gone').mockResolvedValue(false);
    const routes = await on();
    expect((await routes.request('GET', '/api/instances/machines', as('right'))).data).toEqual([{ id: 'm', ownerId: 'bo', name: 'desk', rootDir: '/x', createdAt: 'then' }]);
    const made = await routes.request('POST', '/api/instances/machines/join-code', as('right'));
    expect([made.status, made.data, made.headers['cache-control']]).toEqual([201, { code: 'c', command: 'curl', expiresAt: 'then' }, 'no-store']);
    expect((await routes.request('DELETE', '/api/instances/machines/m', as('right'))).data).toEqual({ success: true });
    expect((await routes.request('DELETE', '/api/instances/machines/gone', as('right'))).status).toBe(404);
    accounts.adoptFrom.mockResolvedValue({ adopted: 1 });
    expect((await routes.request('POST', '/api/instances/machines/adopt', { ...as('right'), body: { machines: [{ id: 'm' }] } })).data).toEqual({ adopted: 1 });
    expect(accounts.adoptFrom).toHaveBeenCalledWith('bo', [{ id: 'm' }]);
  });

  it('refuses a caller it does not know, telling nothing', async () => {
    accounts.list.mockClear();
    const routes = await on();
    for (const [method, path] of [['GET', ''], ['POST', '/join-code'], ['POST', '/adopt'], ['DELETE', '/m']] as const) {
      const refused = await routes.request(method, `/api/instances/machines${path}`, as('wrong'));
      expect([refused.status, refused.data]).toEqual([401, { error: 'unknown instance or credential' }]);
    }
    expect(accounts.list).not.toHaveBeenCalled();
  });
});
