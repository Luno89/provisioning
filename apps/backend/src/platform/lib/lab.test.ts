import { describe, expect, it } from 'vitest';
import { labFrom, plaintextProblem, staysPrivate } from './lab.js';

describe('a lab', () => {
  it('is marked as CLAUDE.md\'s Lab mode says, CERTIFICATES=internal or an older root\'s ROOT_TLS=internal', () => {
    expect(labFrom({ CERTIFICATES: 'internal' })).toBe(true);
    expect(labFrom({ ROOT_TLS: 'internal' })).toBe(true);
    expect(labFrom({ CERTIFICATES: 'acme', ROOT_TLS: 'internal' })).toBe(false);
    expect(labFrom({})).toBe(false);
  });

  it('is never a root on a real domain, whatever its env says', () => {
    expect(labFrom({ CERTIFICATES: 'internal', DOMAIN: 'koala.internal', INGRESS_DOMAIN: 'koala.internal' })).toBe(true);
    expect(labFrom({ CERTIFICATES: 'internal', DOMAIN: 'koala.localhost', INGRESS_DOMAIN: 'people.localhost' })).toBe(true);
    expect(labFrom({ CERTIFICATES: 'internal', DOMAIN: 'nowrinkles.dev' })).toBe(false);
    expect(labFrom({ ROOT_TLS: 'internal', DOMAIN: 'koala.internal', INGRESS_DOMAIN: 'nowrinkles.app' })).toBe(false);
  });
});

describe('an address that never leaves this machine or its private network', () => {
  it('is loopback, a private, mesh or reserved address, or a name under .internal or .localhost', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.2.2', '100.64.1.2', '203.0.113.2', '[::1]', 'app.koala.internal', 'people.localhost']) {
      expect(staysPrivate(host), host).toBe(true);
    }
    for (const host of ['app.nowrinkles.dev', '8.8.8.8', '[2001:4860:4860::8888]', 'internal.example.com', 'localhost.example.com']) {
      expect(staysPrivate(host), host).toBe(false);
    }
  });
});

describe('plain http to root', () => {
  const production = { NODE_ENV: 'production' };

  it('is refused in production when it would cross the open internet', () => {
    expect(plaintextProblem('ROOT_URL', 'http://app.nowrinkles.dev', production)).toBe('ROOT_URL is http://app.nowrinkles.dev: plain http to an address on the open internet. In production Koala talks to root only over https, so set ROOT_URL to root\'s https address');
    expect(plaintextProblem('ROOT_URL', 'ftp://app.nowrinkles.dev', production)).toMatch(/neither https nor http/);
    expect(plaintextProblem('ROOT_URL', 'not a url', production)).toMatch(/is not an address/);
  });

  it('is fine over https, outside production, in a lab, and to an address that stays private, as the suites and the rehearsal use', () => {
    expect(plaintextProblem('ROOT_URL', 'https://app.nowrinkles.dev', production)).toBeUndefined();
    expect(plaintextProblem('ROOT_URL', 'http://app.nowrinkles.dev', {})).toBeUndefined();
    expect(plaintextProblem('ROOT_URL', 'http://root.example', { ...production, CERTIFICATES: 'internal' })).toBeUndefined();
    for (const url of ['http://localhost:3002', 'http://10.0.2.2:3241', 'http://203.0.113.2:3241', 'http://app.koala.internal:3001']) {
      expect(plaintextProblem('ROOT_URL', url, production), url).toBeUndefined();
    }
  });
});
