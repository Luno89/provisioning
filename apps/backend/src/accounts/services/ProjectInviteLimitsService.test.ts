import { describe, expect, it } from 'vitest';
import { principalOf } from '../../platform/lib/permissions.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { ProjectInviteLimitsService } from './ProjectInviteLimitsService.js';

const now = new Date('2026-10-26T12:00:00.000Z');

async function setUp() {
  const db = memoryDatabase();
  for (const user of [
    { id: 'ann', email: 'ann@example.com' },
    { id: 'root-admin', email: 'admin@example.com', roles: ['operator' as const] },
    { id: 'space-1', email: 'space-1@checks', space: { person: 'ann', checkRunId: 'c', scenarioId: 's', models: 'borrowed' as const, world: {} } },
  ]) await db.accounts.saveUser({ twoFactorEnabled: false, createdAt: 't', emailVerified: true, ...user });
  await db.accounts.saveInvite({ id: 'i1', codeHash: 'h1', createdBy: 'ann', createdAt: '2026-10-26T11:00:00.000Z', expiresAt: '2026-11-09T11:00:00.000Z', email: 'cy@example.com', project: { name: 'Shop', role: 'client', join: 'j' }, makesAccount: true });
  await db.accounts.saveInvite({ id: 'i2', codeHash: 'h2', createdBy: 'ann', createdAt: '2026-10-26T11:00:00.000Z', expiresAt: '2026-11-09T11:00:00.000Z', email: 'bo@example.com', project: { name: 'Shop', role: 'client', join: 'k' }, makesAccount: false });
  return { db, service: new ProjectInviteLimitsService({ store: db.accounts, principalFor: (user) => principalOf(user, { role: 'root' }), now: () => now }) };
}

describe('how many people a person\'s project invites may bring to Koala', () => {
  it('starts at ten accounts and twenty invites an hour, and lists everyone but admins and check spaces with what their invites made', async () => {
    const { service } = await setUp();
    expect(await service.limits()).toEqual({ accounts: 10, perHour: 20 });
    expect(await service.overview()).toEqual({ accounts: 10, perHour: 20, people: [{ id: 'ann', email: 'ann@example.com', made: 1 }] });
  });

  it('counts only the invites still open, and shows a person\'s own allowance beside what they made', async () => {
    const { db, service } = await setUp();
    await db.accounts.saveInvite({ id: 'i3', codeHash: 'h3', createdBy: 'ann', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-15T00:00:00.000Z', email: 'old@example.com', project: { name: 'Shop', role: 'client', join: 'l' }, makesAccount: true });
    await service.setOwn('ann', 4);
    expect((await service.overview()).people).toEqual([{ id: 'ann', email: 'ann@example.com', made: 1, own: 4 }]);
  });

  it('lets an admin change the defaults, refusing what is not a whole number', async () => {
    const { service } = await setUp();
    expect(await service.setLimits({ accounts: 3 })).toEqual({ ok: true, value: { accounts: 3, perHour: 20 } });
    expect(await service.setLimits({ perHour: 5 })).toEqual({ ok: true, value: { accounts: 3, perHour: 5 } });
    expect(await service.setLimits({ perHour: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(await service.setLimits({ accounts: 1.5 })).toMatchObject({ ok: false, status: 400 });
    expect(await service.limits()).toEqual({ accounts: 3, perHour: 5 });
  });

  it('changes nothing when told nothing to change', async () => {
    const { service } = await setUp();
    expect(await service.setLimits({})).toEqual({ ok: true, value: { accounts: 10, perHour: 20 } });
  });

  it('gives one person an allowance of their own, and takes it away again', async () => {
    const { db, service } = await setUp();
    expect(await service.setOwn('ann', 25)).toEqual({ ok: true, value: { id: 'ann', email: 'ann@example.com', made: 1, own: 25 } });
    expect((await db.accounts.getUserById('ann'))?.inviteAccounts).toBe(25);
    expect(await service.setOwn('ann', null)).toEqual({ ok: true, value: { id: 'ann', email: 'ann@example.com', made: 1 } });
    expect((await db.accounts.getUserById('ann'))?.inviteAccounts).toBeUndefined();
  });

  it('refuses an account that is not a person\'s, an allowance that is not a whole number, and a request that says nothing', async () => {
    const { service } = await setUp();
    expect(await service.setOwn('nobody', 3)).toMatchObject({ ok: false, status: 404 });
    expect(await service.setOwn('space-1', 3)).toMatchObject({ ok: false, status: 404 });
    expect(await service.setOwn('ann', -1)).toMatchObject({ ok: false, status: 400 });
    expect(await service.setOwn('ann', undefined)).toMatchObject({ ok: false, status: 400 });
  });

  it('reads the clock when none is given', async () => {
    const db = memoryDatabase();
    await db.accounts.saveUser({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, createdAt: 't', emailVerified: true });
    const service = new ProjectInviteLimitsService({ store: db.accounts, principalFor: (user) => principalOf(user, { role: 'root' }) });
    expect((await service.overview()).people).toEqual([{ id: 'ann', email: 'ann@example.com', made: 0 }]);
    expect(await service.setOwn('ann', 2)).toMatchObject({ ok: true, value: { made: 0, own: 2 } });
  });
});
