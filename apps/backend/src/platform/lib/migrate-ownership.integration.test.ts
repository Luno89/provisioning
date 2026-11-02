import { describe, expect, it } from 'vitest';
import { testDatabase } from './test-database.js';
import { migrateLegacyOwnership, operatorsFromAdmins, ownUnownedProjects } from './migrate-ownership.js';

const person = (id: string, createdAt: string, operator = false) => ({ id, email: `${id}@example.com`, twoFactorEnabled: false, emailVerified: true, createdAt, ...(operator ? { roles: ['operator' as const] } : {}) });

describe('records nobody owned', () => {
  it('go to the operator, so a record with no owner is reachable by nobody afterwards', async () => {
    const db = await testDatabase();
    await db.accounts.saveUser(person('old', '2026-01-01'));
    await db.accounts.saveUser(person('op', '2026-02-01', true));
    await db.projects.saveProjectInfo({ id: 'legacy', name: 'Legacy', createdAt: 't' } as never);
    await db.projects.saveProjectInfo({ id: 'mine', name: 'Mine', ownerId: 'old', createdAt: 't' } as never);
    await db.infrastructure.saveCluster({ id: 'c', name: 'c', provider: 'k3d', status: 'healthy' } as never);

    expect(await ownUnownedProjects(db, { role: 'combined' })).toEqual({ owned: 1 });
    await migrateLegacyOwnership(db, { role: 'combined' });
    const projects = await db.projects.getProjects();
    expect(projects.find((project) => project.id === 'legacy')?.ownerId).toBe('op');
    expect(projects.find((project) => project.id === 'mine')?.ownerId).toBe('old');
    expect((await db.infrastructure.getClusters())[0]?.ownerId).toBe('op');
    expect(await ownUnownedProjects(db, { role: 'combined' })).toEqual({ owned: 0 });
    await db.close();
  });

  it('go to the instance\'s owner on an instance, whatever role is stored', async () => {
    const db = await testDatabase();
    await db.accounts.saveUser(person('stamped', '2026-01-01', true));
    await db.accounts.saveUser(person('owner', '2026-02-01'));
    await db.projects.saveProjectInfo({ id: 'legacy', name: 'Legacy', createdAt: 't' } as never);
    await ownUnownedProjects(db, { role: 'instance', instanceOwnerId: 'owner' });
    expect((await db.projects.getProjects())[0]?.ownerId).toBe('owner');
    await db.close();
  });

  it('make the oldest account the operator where accounts are held and none is, and nobody on the hub', async () => {
    const db = await testDatabase();
    await db.accounts.saveUser(person('young', '2026-03-01'));
    await db.accounts.saveUser(person('old', '2026-01-01'));
    await db.projects.saveProjectInfo({ id: 'legacy', name: 'Legacy', createdAt: 't' } as never);
    expect(await ownUnownedProjects(db, { role: 'hub' })).toEqual({ owned: 0, left: 1 });
    expect((await db.accounts.getUserById('old'))?.roles).toBeUndefined();
    expect(await ownUnownedProjects(db, { role: 'root' })).toEqual({ owned: 1 });
    expect((await db.accounts.getUserById('old'))?.roles).toEqual(['operator']);
    await db.close();
  });
});

describe('admins from before roles', () => {
  it('become operators once, their old flag gone, and a later start changes nothing', async () => {
    const db = await testDatabase();
    const users = (database: unknown, name: string) => (database as { db: import('mongodb').Db }).db.collection(name);
    await db.accounts.saveUser(person('plain', '2026-01-01'));
    await db.accounts.saveUser(person('kept', '2026-01-02', true));
    await users(db, 'users').insertOne({ _id: 'old-admin', email: 'old@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: '2025-12-01', isAdmin: true } as never);
    await users(db, 'users').insertOne({ _id: 'old-plain', email: 'plain-old@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: '2025-12-02', isAdmin: false } as never);
    expect(await operatorsFromAdmins(db, '2026-10-29T00:00:00.000Z')).toEqual({ granted: 1 });
    expect((await db.accounts.getUserById('old-admin'))?.roles).toEqual(['operator']);
    expect((await db.accounts.getUserById('kept'))?.roles).toEqual(['operator']);
    expect((await db.accounts.getUserById('plain'))?.roles).toBeUndefined();
    expect(await users(db, 'users').countDocuments({ isAdmin: { $exists: true } })).toBe(0);
    expect(await operatorsFromAdmins(db, '2026-10-30T00:00:00.000Z')).toEqual({});
    await db.close();
  });
});
