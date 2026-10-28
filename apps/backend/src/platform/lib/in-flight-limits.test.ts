import { describe, expect, it } from 'vitest';
import { IN_FLIGHT, InFlightLimits, limitedAddress, limitedPath } from './in-flight-limits.js';

describe('how many requests one address may have open at once', () => {
  it('starts at 50 for each address on its own, and frees a place as each finishes', () => {
    const limits = new InFlightLimits();
    expect(limits.cap).toBe(50);
    for (let at = 0; at < 50; at += 1) expect(limits.enter('203.0.113.9')).toBe(true);
    expect(limits.enter('203.0.113.9')).toBe(false);
    expect(limits.enter('198.51.100.7')).toBe(true);
    limits.leave('203.0.113.9');
    expect(limits.inFlight('203.0.113.9')).toBe(49);
    expect(limits.enter('203.0.113.9')).toBe(true);
  });

  it('grows while answers come as fast as they usually do, up to its ceiling', () => {
    const limits = new InFlightLimits();
    for (let at = 0; at < 200; at += 1) limits.answered(0.02);
    expect(limits.cap).toBe(IN_FLIGHT.ceiling);
  });

  it('shrinks when answers slow well past what is usual, never below its floor, and grows back once they recover', () => {
    const limits = new InFlightLimits();
    for (let at = 0; at < 300; at += 1) limits.answered(0.02);
    limits.answered(0.5);
    limits.answered(0.5);
    const slowed = limits.cap;
    expect(slowed).toBeLessThan(IN_FLIGHT.ceiling);
    for (let at = 0; at < 100; at += 1) limits.answered(5);
    expect(limits.cap).toBeGreaterThanOrEqual(IN_FLIGHT.floor);
    expect(limits.cap).toBeLessThan(slowed);
    const low = limits.cap;
    for (let at = 0; at < 600; at += 1) limits.answered(0.02);
    expect(limits.cap).toBeGreaterThan(low);
  });

  it('limits only addresses on the open internet, and not an instance\'s relay, which is held open by design', () => {
    expect(limitedAddress('203.0.113.9')).toBe(false);
    expect(limitedAddress('8.8.8.8')).toBe(true);
    expect(limitedAddress('::ffff:8.8.8.8')).toBe(true);
    expect(limitedAddress('2606:4700::1111')).toBe(true);
    expect(limitedAddress('127.0.0.1')).toBe(false);
    expect(limitedAddress('::1')).toBe(false);
    expect(limitedAddress('10.42.0.7')).toBe(false);
    expect(limitedAddress('100.64.0.3')).toBe(false);
    expect(limitedAddress('')).toBe(false);
    expect(limitedPath('/api/projects')).toBe(true);
    expect(limitedPath('/api/hub-instance/projects/p1/relay')).toBe(false);
    expect(limitedPath('/api/hub-instance/projects/p1/changes')).toBe(true);
  });
});
