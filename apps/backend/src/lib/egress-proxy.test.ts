import { describe, it, expect } from 'vitest';
import { hostProblem, proxyPassword, proxyUrlFor, proxyUser, renderGrants } from './egress-proxy.js';

describe('proxy credentials', () => {
  it('are stable per owner and persona, and differ between them', () => {
    expect(proxyUser('u1', 'executor')).toBe(proxyUser('u1', 'executor'));
    expect(proxyUser('u1', 'executor')).not.toBe(proxyUser('u2', 'executor'));
    expect(proxyUser('u1', 'executor')).not.toBe(proxyUser('u1', 'judge'));
    expect(proxyPassword('s', 'a1')).not.toBe(proxyPassword('t', 'a1'));
    expect(proxyUrlFor('s', 'u1', 'executor')).toMatch(/^http:\/\/a[0-9a-f]{20}:[0-9a-f]{32}@egress-proxy\.koala-egress\.svc\.cluster\.local:8888$/);
  });
});

describe('the grants file', () => {
  it('lets each persona reach only its own hosts and ports, 443 unless granted another', () => {
    const { users, acls } = renderGrants('s', [
      { ownerId: 'u1', agentSlug: 'executor', host: 'API.stripe.com' },
      { ownerId: 'u1', agentSlug: 'executor', host: 'files.example.org', ports: [8443] },
      { ownerId: 'u2', agentSlug: 'executor', host: 'github.com' },
    ]);
    const one = proxyUser('u1', 'executor');
    const two = proxyUser('u2', 'executor');
    expect(users.map((entry) => entry.user).sort()).toEqual([one, two].sort());
    expect(acls).toContain(`acl hosts_${one} dstdomain api.stripe.com files.example.org`);
    expect(acls).toContain(`acl ports_${one} port 443 8443`);
    expect(acls).toContain(`acl hosts_${two} dstdomain github.com`);
    expect(acls).toContain(`http_access allow CONNECT user_${two} hosts_${two} ports_${two}`);
  });

  it('is empty with no grants', () => {
    expect(renderGrants('s', [])).toEqual({ users: [], acls: '' });
  });
});

describe('what can be granted', () => {
  it('is a host name, not an address, a URL or nothing', () => {
    expect(hostProblem('api.stripe.com')).toBeUndefined();
    expect(hostProblem('.example.com')).toBeUndefined();
    expect(hostProblem('10.0.0.5')).toContain('not an address');
    expect(hostProblem('https://x.com/a')).toContain('not a host name');
    expect(hostProblem('')).toContain('name the host');
  });
});
