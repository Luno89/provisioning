import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { egressReachProblem, INTERNAL_RANGES, publicIpBlock, validateLocalEgressRules } from './egress-rules.js';

describe('validateLocalEgressRules', () => {
  it('allows nothing configured at all', () => {
    expect(validateLocalEgressRules(undefined)).toBeUndefined();
  });

  it('accepts a plain hostname, with or without ports', () => {
    expect(validateLocalEgressRules([{ host: 'registry.npmjs.org' }])).toBeUndefined();
    expect(validateLocalEgressRules([{ host: 'registry.npmjs.org', ports: [443] }])).toBeUndefined();
  });

  it('refuses a non-list', () => {
    expect(validateLocalEgressRules({ host: 'x' })).toMatch(/list of rules/);
  });

  it('refuses a rule with no host', () => {
    expect(validateLocalEgressRules([{ ports: [443] }])).toMatch(/needs a host/);
    expect(validateLocalEgressRules([{ host: '' }])).toMatch(/needs a host/);
  });

  it('refuses something that is not a valid hostname', () => {
    expect(validateLocalEgressRules([{ host: '10.0.0.0/8' }])).toMatch(/not a valid hostname/);
    expect(validateLocalEgressRules([{ host: 'not a host' }])).toMatch(/not a valid hostname/);
    expect(validateLocalEgressRules([{ host: '-leading-hyphen.com' }])).toMatch(/not a valid hostname/);
  });

  it('refuses an invalid port the same way validateEgressRules does', () => {
    expect(validateLocalEgressRules([{ host: 'x.com', ports: [0] }])).toMatch(/not a valid port/);
    expect(validateLocalEgressRules([{ host: 'x.com', ports: ['443'] }])).toMatch(/not a valid port/);
  });
});


describe('what a tree type\'s network rule may open', () => {
  const mine = new Set(['shop-ab12cd']);

  it('opens the namespace of one of the person\'s own apps', () => {
    expect(egressReachProblem([{ namespace: 'shop-ab12cd', ports: [80] }], mine)).toBeUndefined();
  });

  it('keeps Koala\'s own services and anyone else\'s apps closed', () => {
    expect(egressReachProblem([{ namespace: 'gitea', ports: [3000] }], mine)).toContain('"gitea" is not one of your apps\' namespaces');
    expect(egressReachProblem([{ namespace: 'books-ff00aa' }], mine)).toContain('"books-ff00aa" is not one of your apps\' namespaces');
  });

  it('opens public addresses and refuses the cluster, the mesh, loopback and the home network', () => {
    expect(egressReachProblem([{ cidr: '1.1.1.1/32', ports: [443] }], mine)).toBeUndefined();
    expect(egressReachProblem([{ cidr: '10.43.0.10/32' }], mine)).toBe('10.43.0.10/32 is inside 10.0.0.0/8, an internal range, and a rule may open only public addresses');
    expect(egressReachProblem([{ cidr: '100.64.0.3/32' }], mine)).toContain('inside 100.64.0.0/10');
    expect(egressReachProblem([{ cidr: '192.168.1.0/24' }], mine)).toContain('inside 192.168.0.0/16');
    expect(egressReachProblem([{ cidr: '169.254.169.254/32' }], mine)).toContain('inside 169.254.0.0/16');
  });

  it('refuses an address that cannot be one', () => {
    expect(egressReachProblem([{ cidr: '300.1.1.1/32' }], mine)).toContain('is not a valid CIDR');
    expect(egressReachProblem([{ cidr: '1.1.1.1/40' }], mine)).toContain('is not a valid CIDR');
  });
});

describe('a public address block in a network policy', () => {
  it('leaves every internal range out of a block that holds them', () => {
    expect(publicIpBlock('0.0.0.0/0')).toEqual({ ipBlock: { cidr: '0.0.0.0/0', except: [...INTERNAL_RANGES] } });
    expect(publicIpBlock('0.0.0.0/4')).toEqual({ ipBlock: { cidr: '0.0.0.0/4', except: ['0.0.0.0/8', '10.0.0.0/8'] } });
    expect(publicIpBlock('8.8.8.0/24')).toEqual({ ipBlock: { cidr: '8.8.8.0/24' } });
  });

  it('refuses a block inside an internal range, whatever wrote it', () => {
    expect(() => publicIpBlock('10.42.0.0/16')).toThrow('10.42.0.0/16 is inside 10.0.0.0/8, an internal range');
  });
});

describe('the egress proxy', () => {
  it('refuses every internal range before it allows anything, whatever a grant or auto mode lets through', () => {
    const conf = readFileSync(join(import.meta.dirname, '../../../../../k8s/koala-egress/egress-proxy.yaml'), 'utf8');
    const ranges = /acl internal dst (.+)$/m.exec(conf)?.[1]?.trim().split(/\s+/) ?? [];
    expect(ranges).toEqual(expect.arrayContaining([...INTERNAL_RANGES]));
    const access = conf.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('http_access') || line.startsWith('include'));
    expect(access[0]).toBe('http_access deny internal');
  });

  it('keeps the grants through every install and upgrade, and restarts onto new rules', () => {
    const repo = join(import.meta.dirname, '../../../../..');
    const applied = readFileSync(join(repo, 'k8s/koala-egress/egress-proxy.yaml'), 'utf8');
    expect(applied).not.toContain('name: egress-grants\n  namespace');
    expect(readFileSync(join(repo, 'k8s/koala-egress-seed/egress-grants.yaml'), 'utf8')).toContain('name: egress-grants');
    const setup = readFileSync(join(repo, 'scripts/instance/platform-services.sh'), 'utf8');
    expect(setup).toMatch(/get configmap egress-grants[^\n]*\n\s*\|\| "\$KUBECTL" --context "\$CONTEXT" apply -f "\$\{ROOT\}\/k8s\/koala-egress-seed\/"/);
    expect(setup).toContain('sha256sum "${ROOT}/k8s/koala-egress/egress-proxy.yaml"');
    expect(setup).toContain('koala.dev/egress-config');
  });
});
