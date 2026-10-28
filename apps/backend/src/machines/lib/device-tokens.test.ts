import { describe, expect, it } from 'vitest';
import {
  DEVICE_TOKEN_DAYS, ROTATE_WITHIN_DAYS, deviceTokenHash, promotedNext, rotationDue, tokenExpired, tokenLifetime, viaOf, withLifetime, withNextToken,
} from './device-tokens.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-28T12:00:00Z');
const at = (days: number) => new Date(now.getTime() + days * DAY);
const current = deviceTokenHash('current-token');
const next = deviceTokenHash('next-token');

describe('a device token lives ninety days', () => {
  it('is issued now and expires ninety days on', () => {
    expect(tokenLifetime(now)).toEqual({ issuedAt: now.toISOString(), expiresAt: at(DEVICE_TOKEN_DAYS).toISOString() });
  });

  it('is expired once its day has passed, and not before', () => {
    expect(tokenExpired({ tokenHash: current, expiresAt: at(1).toISOString() }, now)).toBe(false);
    expect(tokenExpired({ tokenHash: current, expiresAt: now.toISOString() }, now)).toBe(true);
    expect(tokenExpired({ tokenHash: current }, now)).toBe(false);
  });

  it('is due for rotation in its last thirty days, or when it was never given a lifetime', () => {
    expect(rotationDue({ tokenHash: current, expiresAt: at(ROTATE_WITHIN_DAYS + 1).toISOString() }, now)).toBe(false);
    expect(rotationDue({ tokenHash: current, expiresAt: at(ROTATE_WITHIN_DAYS).toISOString() }, now)).toBe(true);
    expect(rotationDue({ tokenHash: current }, now)).toBe(true);
  });

  it('is not due again while a next token waits to be taken', () => {
    expect(rotationDue({ tokenHash: current, expiresAt: at(2).toISOString(), nextTokenHash: next, nextExpiresAt: at(90).toISOString() }, now)).toBe(false);
  });
});

describe('which token a device may present', () => {
  const rotating = withNextToken({ tokenHash: current, issuedAt: at(-80).toISOString(), expiresAt: at(10).toISOString() }, next, now);

  it('is the current one, or the next one until it is taken', () => {
    expect(viaOf(rotating, current, now)).toEqual({ via: 'current', expired: false });
    expect(viaOf(rotating, next, now)).toEqual({ via: 'next', expired: false });
    expect(viaOf(rotating, deviceTokenHash('guess'), now)).toBeUndefined();
  });

  it('says when the one presented has expired', () => {
    expect(viaOf({ tokenHash: current, expiresAt: at(-1).toISOString() }, current, now)).toEqual({ via: 'current', expired: true });
  });

  it('once taken, the next token is the only one', () => {
    const promoted = promotedNext(rotating);
    expect(promoted).toEqual({ tokenHash: next, issuedAt: now.toISOString(), expiresAt: at(DEVICE_TOKEN_DAYS).toISOString() });
    expect(viaOf(promoted, current, now)).toBeUndefined();
    expect(viaOf(promoted, next, now)).toEqual({ via: 'current', expired: false });
    expect(promotedNext({ tokenHash: current })).toEqual({ tokenHash: current });
  });

  it('a token from before lifetimes is given one now', () => {
    expect(withLifetime({ tokenHash: current }, now)).toEqual({ tokenHash: current, ...tokenLifetime(now) });
    expect(withLifetime({ tokenHash: current, expiresAt: at(5).toISOString() }, now)).toEqual({ tokenHash: current, expiresAt: at(5).toISOString() });
    expect(withLifetime({}, now)).toEqual({});
  });
});
