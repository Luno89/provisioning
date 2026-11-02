import { describe, expect, it } from 'vitest';
import { testDatabase } from '../lib/test-database.js';
import { LOCKOUT, TWO_FACTOR_LOCKOUT } from '../lib/http-limits.js';
import { SignInAttemptLog } from './SignInAttemptLog.js';

describe('the failed sign-ins and codes an account has had', () => {
  it('lock on the failure that crosses the line, say so once, and still lock after the backend restarts', async () => {
    const db = await testDatabase();
    const clock = 7_000_000;
    const log = new SignInAttemptLog(db.platform, () => clock);
    const locks: boolean[] = [];
    for (let n = 0; n < LOCKOUT.after + 1; n += 1) locks.push((await log.failed('account:ann@example.com', LOCKOUT)).locked);
    expect(locks.filter(Boolean)).toHaveLength(1);
    expect(locks[LOCKOUT.after - 1]).toBe(true);
    const restarted = new SignInAttemptLog(db.platform, () => clock + 1_000);
    expect(await restarted.lockedUntil('account:ann@example.com', LOCKOUT)).toBe(clock + LOCKOUT.forMs);
    expect(await restarted.lockedUntil('device:d1', LOCKOUT)).toBeUndefined();
  });

  it('count codes on their own rule, and forget a key on success', async () => {
    const db = await testDatabase();
    const log = new SignInAttemptLog(db.platform, () => 9_000_000);
    for (let n = 0; n < TWO_FACTOR_LOCKOUT.after; n += 1) await log.failed('two-factor:u1', TWO_FACTOR_LOCKOUT);
    expect(await log.lockedUntil('two-factor:u1', TWO_FACTOR_LOCKOUT)).toBeDefined();
    await log.succeeded('two-factor:u1');
    expect(await log.lockedUntil('two-factor:u1', TWO_FACTOR_LOCKOUT)).toBeUndefined();
  });

  it('counts failures that arrive together, so guesses sent at once all count', async () => {
    const db = await testDatabase();
    const log = new SignInAttemptLog(db.platform, () => 11_000_000);
    await Promise.all(Array.from({ length: LOCKOUT.after }, () => log.failed('account:bo@example.com', LOCKOUT)));
    expect(await log.lockedUntil('account:bo@example.com', LOCKOUT)).toBeDefined();
  });
});
