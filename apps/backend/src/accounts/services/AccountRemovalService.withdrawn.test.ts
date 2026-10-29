import { describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { principalOf } from '../../platform/lib/permissions.js';
import { AccountRemovalService } from './AccountRemovalService.js';

describe('root\'s People with a withdrawn release', () => {
  it('says when an instance runs a release root withdrew', async () => {
    const db = await testDatabase();
    await db.accounts.saveUser({ id: 'p1', email: 'p1@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: 'then' } as never);
    await db.instances.saveInstance({ id: 'inst-1', ownerId: 'p1', name: 'bob', url: 'https://bob.koala.dev', status: 'ready', createdAt: 'then', updatedAt: 'then', running: 'c3', updates: { auto: false, picked: 'c3' } } as never);
    const releases = [
      { imageTag: 'b2', version: 'v2026.10.25', servedAt: '2026-10-25T00:00:00.000Z' },
      { imageTag: 'c3', version: 'v2026.10.26', servedAt: '2026-10-26T00:00:00.000Z', withdrawn: { at: '2026-10-27T00:00:00.000Z', by: 'root rolled back to v2026.10.25' } },
    ];
    const removal = new AccountRemovalService({
      store: db, workflows: {} as never, now: () => 'now', principalFor: (user) => principalOf(user, { role: 'root' }),
      instances: () => db.instances.getInstances(), releases: async () => releases,
    });
    expect((await removal.people()).find((person) => person.id === 'p1')?.instance).toMatchObject({ version: 'v2026.10.26', versionWithdrawn: true, autoUpdates: false });
  });
});
