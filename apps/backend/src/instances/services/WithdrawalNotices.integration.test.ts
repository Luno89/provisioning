import { describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { WithdrawalNotices } from './WithdrawalNotices.js';

const instance = (id: string, updates: { auto: boolean; picked?: string }, running: string) =>
  ({ id, ownerId: `owner-${id}`, name: `name${id}`, url: `https://${id}`, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', updates, running });

describe('telling an owner their release was withdrawn', () => {
  it('emails the owner of an instance that picked a withdrawn release once per withdrawal, and nobody on auto', async () => {
    const db = await testDatabase();
    await db.instances.recordRelease({ imageTag: 'old', version: 'v2026.10.29', servedAt: '2026-10-29T00:00:00.000Z' });
    await db.instances.recordRelease({ imageTag: 'new', version: 'v2026.10.30', servedAt: '2026-10-30T00:00:00.000Z' });
    await db.instances.withdrawRelease('new', { at: '2026-10-31T00:00:00.000Z', by: 'root rolled back to v2026.10.29' });
    await db.instances.saveInstance(instance('1', { auto: false, picked: 'new' }, 'new') as never);
    await db.instances.saveInstance(instance('2', { auto: true }, 'new') as never);
    await db.instances.saveInstance(instance('3', { auto: false, picked: 'old' }, 'old') as never);
    const sent: { ownerId: string; subject: string; text: string }[] = [];
    const notices = new WithdrawalNotices(db.instances, { toOwner: async (ownerId, message) => { sent.push({ ownerId, ...message }); } }, 'old');

    expect(await notices.tell()).toBe(1);
    expect(sent).toEqual([{
      ownerId: 'owner-1',
      subject: 'v2026.10.30 was withdrawn',
      text: 'Your instance name1 is set to run v2026.10.30, which was withdrawn when root rolled back to v2026.10.29. It stays on it until you choose otherwise. Root runs v2026.10.29; you can move to it in your instance\'s Settings → Updates, or switch automatic updates back on.',
    }]);
    expect(await notices.tell()).toBe(0);

    await db.instances.withdrawRelease('new', undefined);
    await db.instances.withdrawRelease('new', { at: '2026-11-02T00:00:00.000Z', by: 'root rolled back to v2026.10.29' });
    expect(await notices.tell()).toBe(1);
  });

  it('tries again next time when the email could not be sent', async () => {
    const db = await testDatabase();
    await db.instances.recordRelease({ imageTag: 'new', version: 'v2026.10.30', servedAt: '2026-10-30T00:00:00.000Z' });
    await db.instances.withdrawRelease('new', { at: '2026-10-31T00:00:00.000Z', by: 'root rolled back to v2026.10.29' });
    await db.instances.saveInstance(instance('1', { auto: false, picked: 'new' }, 'new') as never);
    let fail = true;
    const notices = new WithdrawalNotices(db.instances, { toOwner: async () => { if (fail) throw new Error('mail is off'); } }, 'old');
    expect(await notices.tell()).toBe(0);
    fail = false;
    expect(await notices.tell()).toBe(1);
  });
});
