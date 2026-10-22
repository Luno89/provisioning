import { describe, expect, it } from 'vitest';
import { afterFailure, lockedSaid, lockedUntil, LOCKOUT, ruleFor } from './http-limits.js';

describe('which public paths are rate limited', () => {
  it('limits sign-in, joining and share links, and nothing signed-in', () => {
    expect(ruleFor('/auth/login')?.name).toBe('sign-in');
    expect(ruleFor('/auth/handoff')?.name).toBe('sign-in');
    expect(ruleFor('/machines/join')?.name).toBe('joining');
    expect(ruleFor('/hub/invitations/abc/accept')?.name).toBe('joining');
    expect(ruleFor('/share/tok')?.name).toBe('share-links');
    expect(ruleFor('/projects')).toBeUndefined();
    expect(ruleFor('/conversations/x/messages')).toBeUndefined();
  });
});

describe('locking an account after repeated failed sign-ins', () => {
  it('locks after the tenth failure in the window, says for how long, and forgets old failures', () => {
    let attempts;
    const start = 1_000_000;
    for (let n = 0; n < LOCKOUT.after - 1; n += 1) attempts = afterFailure(attempts, start + n * 1000);
    expect(lockedUntil(attempts, start + 20_000)).toBeUndefined();
    attempts = afterFailure(attempts, start + 20_000);
    const until = lockedUntil(attempts, start + 21_000);
    expect(until).toBe(start + 20_000 + LOCKOUT.forMs);
    expect(lockedSaid(until!, start + 21_000)).toBe('Too many failed sign-ins for this account; try again in 15 minutes.');
    expect(lockedUntil(attempts, start + 20_000 + LOCKOUT.forMs + 1)).toBeUndefined();
    expect(afterFailure(attempts, start + LOCKOUT.windowMs + 30_000).failures).toEqual([start + LOCKOUT.windowMs + 30_000]);
  });
});
