import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../testing/memory-database.js';
import { SessionEnds } from './SessionEnds.js';

describe('the sessions signed out of', () => {
  it('are refused at once, kept in the store, and refused again by a process that starts later', async () => {
    const db = memoryDatabase();
    const now = Date.now();
    const here = new SessionEnds(db.platform);
    await here.end('jti-1', now + 60_000);
    expect(here.ended('jti-1')).toBe(true);
    expect(here.ended('jti-2')).toBe(false);
    const restarted = new SessionEnds(db.platform);
    expect(restarted.ended('jti-1')).toBe(false);
    await restarted.load();
    expect(restarted.ended('jti-1')).toBe(true);
  });

  it('tells each listener once when a session is first heard to have ended, and not again for the same one', async () => {
    const ends = new SessionEnds(memoryDatabase().platform, () => 1_000);
    const heard: string[] = [];
    ends.onEnd((id) => heard.push(id));
    ends.onEnd((id) => heard.push(`also ${id}`));
    await ends.end('jti-1', 5_000);
    await ends.end('jti-1', 6_000);
    await ends.end('jti-2', 5_000);
    expect(heard).toEqual(['jti-1', 'also jti-1', 'jti-2', 'also jti-2']);
  });

  it('forgets a session once it would have expired', async () => {
    let clock = 1_000;
    const ends = new SessionEnds(memoryDatabase().platform, () => clock);
    await ends.end('jti-1', 5_000);
    expect(ends.ended('jti-1')).toBe(true);
    clock = 5_001;
    expect(ends.ended('jti-1')).toBe(false);
  });
});

describe('hearing the sessions another process signed out of', () => {
  it('takes up a session a process beside it ended as soon as it is written, and tells the listeners', async () => {
    const db = memoryDatabase();
    let clock = Date.now();
    const one = new SessionEnds(db.platform, () => clock);
    const other = new SessionEnds(db.platform, () => clock);
    await other.follow();
    const heard = new Promise<string>((done) => other.onEnd(done));

    await one.end('jti-3', clock + 120_000);

    expect(await heard).toBe('jti-3');
    expect(other.ended('jti-3')).toBe(true);
    clock += 121_000;
    expect(other.ended('jti-3')).toBe(false);
    await other.stop();
  });

  it('starts listening before it reads what ended already, so nothing written in between is missed', async () => {
    const store = mock<ConstructorParameters<typeof SessionEnds>[0]>();
    const order: string[] = [];
    store.watchSessionEnds.mockImplementation(() => { order.push('listen'); return { ready: Promise.resolve().then(() => { order.push('open'); }), close: async () => undefined }; });
    store.sessionsEndedSince.mockImplementation(async () => { order.push('read'); return []; });
    const ends = new SessionEnds(store);

    await ends.follow();
    await ends.follow();

    expect(order).toEqual(['listen', 'open', 'read']);
  });
});
