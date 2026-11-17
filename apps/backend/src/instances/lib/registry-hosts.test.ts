import { describe, expect, it } from 'vitest';
import { forPushing, hostOf, kanikoRegistryArgs, registryAuths, registryHosts } from './registry-hosts.js';

const pool = registryHosts('http://gitea-http.gitea.svc.cluster.local:3000/', '127.0.0.1:35010');
const one = registryHosts('http://10.0.0.130:31737', undefined);

describe('the registry an instance pushes to and pulls from', () => {
  it('is one address unless a pull address is given', () => {
    expect(one).toEqual({ push: '10.0.0.130:31737', pull: '10.0.0.130:31737' });
    expect(registryHosts('http://10.0.0.130:31737', ' ')).toEqual(one);
    expect(pool).toEqual({ push: 'gitea-http.gitea.svc.cluster.local:3000', pull: '127.0.0.1:35010' });
    expect(hostOf('https://registry.example/')).toBe('registry.example');
  });

  it('pushes an image named for pulling to the push address, and leaves any other image as it is', () => {
    expect(forPushing('127.0.0.1:35010/koala-u1/shop:abc', pool)).toBe('gitea-http.gitea.svc.cluster.local:3000/koala-u1/shop:abc');
    expect(forPushing('odoo:20', pool)).toBe('odoo:20');
    expect(forPushing('127.0.0.1:350100/x:1', pool)).toBe('127.0.0.1:350100/x:1');
    expect(forPushing('10.0.0.130:31737/koala-u1/shop:abc', one)).toBe('10.0.0.130:31737/koala-u1/shop:abc');
  });

  it('kaniko is told only Koala\'s own registry is plain http, whether the pull and push hosts are one or two', () => {
    expect(kanikoRegistryArgs(one)).toEqual(['--insecure-registry=10.0.0.130:31737', '--skip-tls-verify-registry=10.0.0.130:31737']);
    expect(kanikoRegistryArgs(pool)).toEqual([
      '--insecure-registry=gitea-http.gitea.svc.cluster.local:3000',
      '--skip-tls-verify-registry=gitea-http.gitea.svc.cluster.local:3000',
      '--insecure-registry=127.0.0.1:35010',
      '--skip-tls-verify-registry=127.0.0.1:35010',
      '--registry-map=127.0.0.1:35010=gitea-http.gitea.svc.cluster.local:3000',
    ]);
    expect([...kanikoRegistryArgs(one), ...kanikoRegistryArgs(pool)].filter((arg) => ['--insecure', '--insecure-pull', '--skip-tls-verify'].includes(arg))).toEqual([]);
  });

  it('lets Kaniko read a base image named for pulling from the push address, and signs in at both', () => {
    expect(registryAuths(one, 'A')).toEqual({ '10.0.0.130:31737': { auth: 'A' } });
    expect(registryAuths(pool, 'A')).toEqual({ 'gitea-http.gitea.svc.cluster.local:3000': { auth: 'A' }, '127.0.0.1:35010': { auth: 'A' } });
  });
});
