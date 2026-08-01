import { describe, it, expect } from 'vitest';
import { checkEndpointUrl, isAllowedIp, isMeshAddress } from './endpoint-url-safety.js';

/**
 * These are security tests, not validation tests. A user-registered endpoint URL is a URL the
 * BACKEND will fetch, from the root node, which runs Headscale's admin API, Mongo, Temporal and
 * the Gitea registry on loopback. Every case below is a way to turn "chat with my model" into a
 * request against the platform's own control plane.
 */

describe('loopback and the platform control plane', () => {
  it('refuses localhost in every spelling', () => {
    for (const url of [
      'http://localhost:8080/v1',
      'http://127.0.0.1:8080/v1',
      'http://127.1/v1',            // still 127.0.0.0/8 — but not a dotted quad, so must not parse as one
      'http://[::1]:8080/v1',
      'http://LOCALHOST:8080/v1',
    ]) {
      expect(checkEndpointUrl(url).ok, url).toBe(false);
    }
  });

  it('refuses every IPv4 shorthand encoding of loopback', () => {
    // The classic SSRF bypass set. These are refused because Node's WHATWG URL parser normalizes
    // all of them to 127.0.0.1 before the range check runs — verified against the running Node,
    // not assumed. Pinned here because the guard silently depends on that normalization: if it
    // ever stopped, "0x7f000001" would sail through as a public hostname.
    for (const url of [
      'http://127.1/v1',
      'http://2130706433/v1',
      'http://0x7f000001/v1',
      'http://0177.0.0.1/v1',
      'http://127.0.0.1./v1',
      'http://[::ffff:127.0.0.1]/v1',
    ]) {
      expect(checkEndpointUrl(url).ok, url).toBe(false);
    }
  });

  it('refuses the Headscale admin API specifically', () => {
    // The concrete attack: HEADSCALE_URL defaults to http://localhost:8080.
    expect(checkEndpointUrl('http://localhost:8080/api/v1/preauthkey').ok).toBe(false);
  });

  it('refuses cloud instance metadata', () => {
    // Hands out instance credentials to anything asking from the host.
    expect(checkEndpointUrl('http://169.254.169.254/latest/meta-data/').ok).toBe(false);
  });

  it('refuses RFC1918 ranges', () => {
    for (const host of ['10.0.0.5', '172.16.0.5', '172.31.255.254', '192.168.1.1']) {
      expect(isAllowedIp(host), host).toBe(false);
    }
  });

  it('refuses bare service names, which is what a container alias looks like', () => {
    for (const url of ['http://mongo:27017/v1', 'http://temporal:7233/v1', 'http://gitea/v1']) {
      expect(checkEndpointUrl(url).ok, url).toBe(false);
    }
  });

  it('refuses internal-looking suffixes', () => {
    for (const url of ['http://foo.internal/v1', 'http://box.local/v1', 'http://x.localhost/v1']) {
      expect(checkEndpointUrl(url).ok, url).toBe(false);
    }
  });
});

describe('the mesh range is allowed — it is the whole point', () => {
  it('accepts a mesh address', () => {
    const r = checkEndpointUrl('http://100.64.0.7:11434/v1');
    expect(r.ok).toBe(true);
    expect(r.literalIp).toBe('100.64.0.7');
  });

  it('recognises the boundaries of 100.64.0.0/10', () => {
    expect(isMeshAddress('100.64.0.0')).toBe(true);
    expect(isMeshAddress('100.127.255.255')).toBe(true);
    // Just outside, both sides — these are public space and must not be mistaken for mesh, or the
    // ownership check that follows would be skipped for a real internet host.
    expect(isMeshAddress('100.63.255.255')).toBe(false);
    expect(isMeshAddress('100.128.0.0')).toBe(false);
  });
});

describe('public endpoints', () => {
  it('accepts a normal https host', () => {
    const r = checkEndpointUrl('https://api.example.com/v1');
    expect(r.ok).toBe(true);
    expect(r.hostname).toBe('api.example.com');
  });

  it('accepts a public IP literal', () => {
    expect(checkEndpointUrl('https://8.8.8.8/v1').ok).toBe(true);
  });
});

describe('malformed and hostile input', () => {
  it('refuses non-http schemes', () => {
    for (const url of ['file:///etc/passwd', 'gopher://x.com/', 'ftp://x.com/']) {
      expect(checkEndpointUrl(url).ok, url).toBe(false);
    }
  });

  it('refuses credentials embedded in the URL', () => {
    // Also an exfiltration shape: the secret ends up in logs and error messages.
    expect(checkEndpointUrl('http://user:pass@api.example.com/v1').ok).toBe(false);
  });

  it('refuses garbage rather than throwing', () => {
    for (const url of ['', 'not a url', '://', 'http://']) {
      expect(() => checkEndpointUrl(url)).not.toThrow();
      expect(checkEndpointUrl(url).ok, url).toBe(false);
    }
  });

  it('does not let an octet over 255 parse as a dotted quad', () => {
    // "999.1.1.1" is not IPv4; if it were treated as one the range checks would be meaningless.
    expect(isAllowedIp('999.1.1.1')).toBe(false);
    expect(isAllowedIp('1.2.3')).toBe(false);
    expect(isAllowedIp('1.2.3.4.5')).toBe(false);
  });

  it('refuses IPv6 wholesale, including v4-mapped loopback', () => {
    // ::ffff:127.0.0.1 is loopback wearing a v6 hat and slips past naive v4-only checks.
    expect(isAllowedIp('::1')).toBe(false);
    expect(isAllowedIp('::ffff:127.0.0.1')).toBe(false);
    expect(isAllowedIp('fc00::1')).toBe(false);
  });
});
