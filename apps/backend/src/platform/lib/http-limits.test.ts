import { describe, expect, it } from 'vitest';
import { afterFailure, attemptsKeyFor, jsonLimitFor, lockedSaid, lockedUntil, LOCKOUT, ruleFor, SignInAttemptLog } from './http-limits.js';

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
    expect(ruleFor('/auth/login')?.countsOnlyFailures).toBe(true);
    expect(ruleFor('/machines/join')?.countsOnlyFailures).toBe(true);
    expect(ruleFor('/share/tok')?.countsOnlyFailures).toBe(false);
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

  it('locks one key without the other, forgets a key on success, and prunes keys whose failures have all aged out', () => {
    const log = new SignInAttemptLog(LOCKOUT, 60_000);
    const start = 5_000_000;
    for (let n = 0; n < LOCKOUT.after; n += 1) log.failed('account:ann@example.com', start + n);
    expect(log.lockedUntil('account:ann@example.com', start + 100)).toBeDefined();
    expect(log.lockedUntil('device:d1', start + 100)).toBeUndefined();
    log.failed('device:d1', start + 200);
    log.succeeded('device:d1');
    expect(log.size).toBe(1);
    log.failed('account:bob@example.com', start + LOCKOUT.windowMs - 1);
    log.prune(start + LOCKOUT.windowMs + 50);
    expect(log.size).toBe(1);
    expect(log.lockedUntil('account:ann@example.com', start + LOCKOUT.windowMs + 50)).toBeUndefined();
    log.failed('account:carol@example.com', start + 2 * LOCKOUT.windowMs + 60_000);
    expect(log.size).toBe(1);
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
