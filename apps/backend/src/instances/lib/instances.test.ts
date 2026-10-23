import { describe, expect, it } from 'vitest';
import { inService, stampServed } from './instances.js';

describe('an instance in service', () => {
  it('is one that is ready, or was ready and now upgrades itself or has rolled back a failed upgrade', () => {
    const served = '2026-10-23T00:00:00.000Z';
    expect(inService({ status: 'ready' })).toBe(true);
    expect(inService({ status: undefined })).toBe(true);
    expect(inService({ status: 'installing', servedAt: served })).toBe(true);
    expect(inService({ status: 'failed', servedAt: served })).toBe(true);
    expect(inService({ status: 'installing' })).toBe(false);
    expect(inService({ status: 'failed' })).toBe(false);
    expect(inService({ status: 'paused', servedAt: served })).toBe(false);
    expect(inService({ status: 'waiting' })).toBe(false);
    expect(inService({ status: 'joined', servedAt: served })).toBe(false);
  });

  it('remembers the first time it was ready, and keeps that through every later report', () => {
    const first = stampServed({ status: 'ready' as const, updatedAt: '2026-10-23T01:00:00.000Z' });
    expect(first.servedAt).toBe('2026-10-23T01:00:00.000Z');
    const upgrading = stampServed({ ...first, status: 'installing' as const, updatedAt: '2026-10-24T01:00:00.000Z' });
    expect(upgrading.servedAt).toBe('2026-10-23T01:00:00.000Z');
    const again = stampServed({ ...upgrading, status: 'ready' as const, updatedAt: '2026-10-25T01:00:00.000Z' });
    expect(again.servedAt).toBe('2026-10-23T01:00:00.000Z');
    expect(stampServed({ status: 'installing' as const, updatedAt: 'x' }).servedAt).toBeUndefined();
  });
});
