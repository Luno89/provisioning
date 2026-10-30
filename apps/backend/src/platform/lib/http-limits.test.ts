import { describe, expect, it } from 'vitest';
import { afterFailure, attemptsKeptUntil, CONFIRM_CODES, confirmCodesSaid, fullUntil, attemptsKeyFor, jsonLimitFor, justLocked, lockedSaid, lockedUntil, LOCKOUT, ruleFor, TWO_FACTOR_LOCKOUT, twoFactorKeyFor, twoFactorLockedSaid } from './http-limits.js';

describe('which public paths are rate limited', () => {
  it('limits sign-in, joining and share links, and nothing signed-in', () => {
    expect(ruleFor('/auth/login')?.name).toBe('sign-in');
    expect(ruleFor('/auth/handoff')?.name).toBe('sign-in');
    expect(ruleFor('/machines/join')?.name).toBe('joining');
    expect(ruleFor('/hub/invitations/abc/accept')?.name).toBe('joining');
    expect(ruleFor('/share/tok')?.name).toBe('share-links');
    expect(ruleFor('/AUTH/2fa/Verify/')?.name).toBe('sign-in');
    expect(ruleFor('/auth//login')?.name).toBe('sign-in');
    expect(ruleFor('/Share/Tok')?.name).toBe('share-links');
    expect(ruleFor('/projects')).toBeUndefined();
    expect(ruleFor('/conversations/x/messages')).toBeUndefined();
  });

  it('counts only failed sign-ins, sign-ups and joins against an address, since a guess fails and a person succeeds, while every opening of a share link counts', () => {
    expect(ruleFor('/auth/register')?.countsOnlyFailures).toBe(true);
    expect(ruleFor('/auth/register/verify')?.name).toBe('sign-in');
    expect(ruleFor('/auth/register/resend')?.name).toBe('sign-in');
    expect(ruleFor('/auth/login')?.countsOnlyFailures).toBe(true);
    expect(ruleFor('/machines/join')?.countsOnlyFailures).toBe(true);
    expect(ruleFor('/share/tok')?.countsOnlyFailures).toBe(false);
  });

  it('counts every password reset asked for, since asking succeeds whether or not the account exists, and only failed resets', () => {
    expect(ruleFor('/auth/password/forgot')?.name).toBe('password-reset');
    expect(ruleFor('/auth/password/forgot/resend')?.countsOnlyFailures).toBe(false);
    expect(ruleFor('/auth/password/reset')?.name).toBe('sign-in');
    expect(ruleFor('/auth/password')).toBeUndefined();
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

describe('whose failures a sign-in counts against', () => {
  it('counts a browser that signed in to this account before on its own, and anything else against the account', () => {
    expect(attemptsKeyFor('ann@example.com', { account: 'ann@example.com', id: 'd1' })).toBe('device:d1');
    expect(attemptsKeyFor('ann@example.com', { account: 'bob@example.com', id: 'd1' })).toBe('account:ann@example.com');
    expect(attemptsKeyFor('ann@example.com', undefined)).toBe('account:ann@example.com');
  });

  it('keeps the failures of a key for as long as they can still lock it', () => {
    expect(attemptsKeptUntil({ failures: [1_000, 9_000] })).toBe(9_000 + LOCKOUT.windowMs);
  });
});

describe('locking an account\'s codes after repeated wrong ones', () => {
  it('locks codes for the account after the fifth wrong one in the window, whatever sign-in they came from', () => {
    let attempts;
    const start = 2_000_000;
    for (let n = 0; n < TWO_FACTOR_LOCKOUT.after - 1; n += 1) attempts = afterFailure(attempts, start + n, TWO_FACTOR_LOCKOUT);
    expect(lockedUntil(attempts, start + 10, TWO_FACTOR_LOCKOUT)).toBeUndefined();
    const before = attempts;
    attempts = afterFailure(attempts, start + 10, TWO_FACTOR_LOCKOUT);
    expect(justLocked(before, attempts, start + 10, TWO_FACTOR_LOCKOUT)).toBe(true);
    expect(justLocked(attempts, afterFailure(attempts, start + 11, TWO_FACTOR_LOCKOUT), start + 11, TWO_FACTOR_LOCKOUT)).toBe(false);
    expect(twoFactorLockedSaid(lockedUntil(attempts, start + 10, TWO_FACTOR_LOCKOUT)!, start + 10)).toBe('Too many wrong codes for this account; codes are refused for 15 minutes.');
    expect(twoFactorKeyFor('u1')).toBe('two-factor:u1');
  });
});

describe('how much JSON a request may send', () => {
  it('lets someone signed in send a large body, and anyone else only a small one', () => {
    expect(jsonLimitFor('/api/conversations/c1', true)).toBe('signedIn');
    expect(jsonLimitFor('/api/auth/login', false)).toBe('signedOut');
    expect(jsonLimitFor('/api/instances/mail', false)).toBe('signedOut');
    expect(jsonLimitFor('/ingress/verify', false)).toBe('signedOut');
  });

  it('lets the scripted model and the hub\'s instances, which check their own keys, send a large body', () => {
    expect(jsonLimitFor('/api/checks/scripted/s1/v1/chat/completions', false)).toBe('signedIn');
    expect(jsonLimitFor('/api/hub-instance/projects/p1/sync', false)).toBe('signedIn');
    expect(jsonLimitFor('/api/hub-root/people/u1', false)).toBe('signedOut');
  });
});

describe('how many confirmation codes an account is sent', () => {
  it('is five in fifteen minutes, the next allowed once the oldest of them is fifteen minutes old', () => {
    const start = 3_000_000;
    let sent;
    for (let n = 0; n < CONFIRM_CODES.after - 1; n += 1) sent = afterFailure(sent, start + n * 60_000, CONFIRM_CODES);
    expect(fullUntil(sent, start + 5 * 60_000)).toBeUndefined();
    sent = afterFailure(sent, start + 5 * 60_000, CONFIRM_CODES);
    expect(fullUntil(sent, start + 6 * 60_000)).toBe(start + CONFIRM_CODES.windowMs);
    expect(fullUntil(sent, start + CONFIRM_CODES.windowMs)).toBeUndefined();
    expect(confirmCodesSaid(start + CONFIRM_CODES.windowMs, start + 6 * 60_000)).toBe('Koala has sent you 5 confirmation codes in the last 15 minutes; ask for another in 9 minutes.');
  });
});
