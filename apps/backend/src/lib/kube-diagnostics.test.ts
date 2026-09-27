import { describe, it, expect } from 'vitest';
import { findDeployment, logsCommand, planRead, trimOutput } from './kube-diagnostics.js';

describe('planRead', () => {
  it('reads inside a deployment\'s namespace', () => {
    expect(planRead({ verb: 'describe', resource: 'pod', name: 'web-1' }, 'billing')).toEqual({ argv: ['describe', 'pod', 'web-1', '-n', 'billing'], clusterScoped: false });
  });

  it('reads nodes, volumes and namespaces across the cluster', () => {
    expect(planRead({ verb: 'get', resource: 'nodes' }, undefined)).toEqual({ argv: ['get', 'nodes'], clusterScoped: true });
  });

  it('refuses anything that changes the cluster, Secrets and ConfigMaps, and a namespaced read with no deployment', () => {
    expect(planRead({ verb: 'delete', resource: 'pods' }, 'billing')).toEqual({ refused: expect.stringContaining('Nothing here changes the cluster') });
    expect(planRead({ verb: 'get', resource: 'secrets' }, 'billing')).toEqual({ refused: expect.stringContaining('Secrets and ConfigMaps cannot be read') });
    expect(planRead({ verb: 'get', resource: 'cm' }, 'billing')).toEqual({ refused: expect.stringContaining('Secrets and ConfigMaps') });
    expect(planRead({ verb: 'get', resource: 'pods' }, undefined)).toEqual({ refused: 'say which of your deployments to look at' });
    expect(planRead({ verb: 'get', resource: 'pods', name: 'x; rm -rf /' }, 'billing')).toEqual({ refused: expect.stringContaining('not a valid object name') });
    expect(planRead({ verb: 'top', resource: 'services' }, 'billing')).toEqual({ refused: 'top reports usage for pods or nodes only.' });
  });
});

describe('the rest', () => {
  it('finds only the owner\'s deployments', () => {
    const all = [{ name: 'Billing', namespace: 'billing', clusterId: 'c', ownerId: 'u1' }, { name: 'Theirs', namespace: 'theirs', clusterId: 'c', ownerId: 'u2' }];
    expect(findDeployment('billing', all, 'u1')?.name).toBe('Billing');
    expect(findDeployment('Theirs', all, 'u1')).toBeUndefined();
  });

  it('tails logs by app label and trims long output from the front', () => {
    expect(logsCommand('billing')).toEqual(['logs', '-n', 'billing', '--all-containers', '--prefix', '--tail', '60', '-l', 'app']);
    expect(trimOutput('abcdef', 3)).toBe('…[earlier output trimmed]\ndef');
  });
});
