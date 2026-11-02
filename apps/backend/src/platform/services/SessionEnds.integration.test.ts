import { describe, expect, it } from 'vitest';
import { testDatabase } from '../lib/test-database.js';
import { SessionEnds } from './SessionEnds.js';

describe('the sessions signed out of', () => {
  it('are refused at once, kept in the database, and refused again by a process that starts later', async () => {
    const db = await testDatabase();
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

  it('are taken up by a process that runs beside the one that ended them, and forgotten once they would have expired', async () => {
    const db = await testDatabase();
    let clock = Date.now();
    const one = new SessionEnds(db.platform, () => clock);
    const other = new SessionEnds(db.platform, () => clock);
    await other.load();
    other.keepReading(() => undefined, 20);
    await one.end('jti-3', clock + 120_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    other.stop();
    expect(other.ended('jti-3')).toBe(true);
    clock += 121_000;
    expect(other.ended('jti-3')).toBe(false);
  });
});
