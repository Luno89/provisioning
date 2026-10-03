import { describe, it, expect } from 'vitest';
import { assertUpstreamTarget, isUpstreamTarget } from './upstream-target.js';

describe('isUpstreamTarget', () => {
  it('takes an address or a hostname with a port', () => {
    expect(isUpstreamTarget('172.17.0.1:30632')).toBe(true);
    expect(isUpstreamTarget('10.64.0.3:80')).toBe(true);
    expect(isUpstreamTarget('a1b2.elb.amazonaws.com:80')).toBe(true);
  });

  it('refuses the gateways of several networks run together', () => {
    expect(isUpstreamTarget('172.17.0.1172.19.0.1172.20.0.1172.21.0.1:30632')).toBe(false);
  });

  it('refuses a missing host, a missing port and a port out of range', () => {
    expect(isUpstreamTarget(':30632')).toBe(false);
    expect(isUpstreamTarget('172.17.0.1')).toBe(false);
    expect(isUpstreamTarget('172.17.0.1:')).toBe(false);
    expect(isUpstreamTarget('172.17.0.1:70000')).toBe(false);
    expect(isUpstreamTarget('172.17.0.1 :80')).toBe(false);
  });
});

describe('assertUpstreamTarget', () => {
  it('names the app and the target it refused', () => {
    expect(() => assertUpstreamTarget('172.17.0.1172.19.0.1:1', 'tabbyapi-production')).toThrow(/tabbyapi-production.*172\.17\.0\.1172\.19\.0\.1:1/);
    expect(assertUpstreamTarget('172.17.0.1:1', 'x')).toBe('172.17.0.1:1');
  });
});
