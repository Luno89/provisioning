import { describe, expect, it } from 'vitest';
import { forwardNotSeen, ipBlockFor, ptrValue, reverseDnsPath, reverseDnsSaid, samePtr } from './reverse-dns.js';

describe('reverse DNS through OVHcloud', () => {
  it('picks the block that holds the address', () => {
    expect(ipBlockFor(['198.51.100.0/28', '203.0.113.7/32'], '203.0.113.7')).toBe('203.0.113.7/32');
    expect(ipBlockFor(['203.0.113.0/24'], '203.0.113.7')).toBe('203.0.113.0/24');
    expect(ipBlockFor([], '203.0.113.7')).toBeUndefined();
    expect(ipBlockFor({ not: 'a list' }, '203.0.113.7')).toBeUndefined();
  });

  it('addresses the block and the address encoded, as OVHcloud\'s API wants them', () => {
    expect(reverseDnsPath('203.0.113.7/32')).toBe('/ip/203.0.113.7%2F32/reverse');
    expect(reverseDnsPath('2001:db8::/64', '2001:db8::1')).toBe('/ip/2001%3Adb8%3A%3A%2F64/reverse/2001%3Adb8%3A%3A1');
  });

  it('sends the name fully qualified and compares names however they are written', () => {
    expect(ptrValue('mail.example.dev')).toBe('mail.example.dev.');
    expect(ptrValue('mail.example.dev.')).toBe('mail.example.dev.');
    expect(samePtr('Mail.Example.dev.', 'mail.example.dev')).toBe(true);
    expect(samePtr(undefined, 'mail.example.dev')).toBe(false);
  });

  it('tells OVHcloud not yet seeing the name from a refusal', () => {
    expect(forwardNotSeen('OVHcloud answered 400: Cannot check if mail.example.dev. resolves to 203.0.113.7')).toBe(true);
    expect(forwardNotSeen('OVHcloud answered 403: This call has not been granted')).toBe(false);
  });

  it('says what to do by hand when it is refused', () => {
    expect(reverseDnsSaid('refused', '203.0.113.7', 'mail.example.dev', 'no grant')).toMatch(/^the reverse DNS of 203\.0\.113\.7 is not set: no grant; set the reverse DNS \(PTR\) of 203\.0\.113\.7 to mail\.example\.dev in OVHcloud's control panel/);
    expect(reverseDnsSaid('set', '203.0.113.7', 'mail.example.dev')).toBe('OVHcloud set the reverse DNS of 203.0.113.7 to mail.example.dev');
  });
});
