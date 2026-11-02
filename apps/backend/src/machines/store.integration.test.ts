import { describe, expect, it } from 'vitest';
import { testDatabase } from '../platform/lib/test-database.js';

const device = { id: 'desk', ownerId: 'owner-1', name: 'desk', rootDir: '/home/person/koala', createdAt: '2026-10-10T00:00:00.000Z', tokenHash: 'old' };

describe('a machine record changed one field at a time', () => {
  it('changes only the fields named, so two changes at once both land', async () => {
    const db = await testDatabase();
    await db.machines.saveLocalAgentDevice(device);
    await Promise.all([
      db.machines.updateLocalAgentDevice('desk', { set: { lastSeenAt: '2026-10-29T00:00:00.000Z' } }),
      db.machines.updateLocalAgentDevice('desk', { set: { nextTokenHash: 'new' }, when: { nextTokenHash: null } }),
      db.machines.updateLocalAgentDevice('desk', { set: { meshIp: '100.64.0.9' } }),
    ]);
    expect((await db.machines.getLocalAgentDevices())[0]).toMatchObject({ tokenHash: 'old', nextTokenHash: 'new', lastSeenAt: '2026-10-29T00:00:00.000Z', meshIp: '100.64.0.9' });
  });

  it('applies a change only while its condition holds, and says whether it did', async () => {
    const db = await testDatabase();
    await db.machines.saveLocalAgentDevice({ ...device, nextTokenHash: 'new' });
    expect(await db.machines.updateLocalAgentDevice('desk', { set: { nextTokenHash: 'another' }, when: { nextTokenHash: null } })).toBe(false);
    expect(await db.machines.updateLocalAgentDevice('desk', { set: { tokenHash: 'new' }, unset: ['nextTokenHash'], when: { nextTokenHash: 'stale' } })).toBe(false);
    expect(await db.machines.updateLocalAgentDevice('desk', { set: { tokenHash: 'new' }, unset: ['nextTokenHash'], when: { nextTokenHash: 'new' } })).toBe(true);
    const [stored] = await db.machines.getLocalAgentDevices();
    expect(stored).toMatchObject({ tokenHash: 'new' });
    expect(stored?.nextTokenHash).toBeUndefined();
  });
});
