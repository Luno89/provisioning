import { describe, it, expect } from 'vitest';
import { planRead, readableNamespaces, READ_VERBS } from './kube-diagnostics.js';

const mine = ['koala-vectors', 'koala-ws-leaf-1'];

describe('what it will never do', () => {
  it('refuses every mutating verb', () => {
    for (const verb of ['delete', 'patch', 'apply', 'edit', 'scale', 'exec', 'cp', 'port-forward', 'drain']) {
      const out = planRead({ verb, resource: 'pods', target: 'koala-vectors' }, mine);
      expect(out).toHaveProperty('refused');
      expect((out as { refused: string }).refused).toMatch(/not a readable action/);
    }
  });

  it('refuses Secrets and ConfigMaps, and says why', () => {
    for (const resource of ['secret', 'secrets', 'configmap', 'configmaps']) {
      const out = planRead({ verb: 'get', resource, target: 'koala-vectors' }, mine) as { refused: string };
      expect(out.refused).toMatch(/cannot be read/i);
      expect(out.refused).toMatch(/credentials/i);
    }
  });

  it('refuses a namespace that is not the caller\'s', () => {
    const out = planRead({ verb: 'get', resource: 'pods', target: 'kube-system' }, mine);
    expect(out).toHaveProperty('refused');
  });

  it('cannot smuggle a namespace through the object name', () => {
    for (const name of ['-n', '--namespace=kube-system', '-n kube-system', '../secrets']) {
      expect(planRead({ verb: 'get', resource: 'pods', name, target: 'koala-vectors' }, mine))
        .toHaveProperty('refused');
    }
  });

  it('never emits a verb outside the allowlist, whatever it is asked', () => {
    for (const verb of ['get', 'describe', 'delete', 'patch', 'DELETE', 'Get']) {
      const out = planRead({ verb, resource: 'pods', target: 'koala-vectors' }, mine);
      if ('argv' in out) expect(READ_VERBS).toContain(out.argv[0]);
    }
  });
});

describe('what it will do', () => {
  it('scopes a namespaced read to the resolved namespace', () => {
    const out = planRead({ verb: 'describe', resource: 'pods', target: 'koala-vectors' }, mine);
    expect(out).toEqual({ argv: ['describe', 'pods', '-n', 'koala-vectors'], namespace: 'koala-vectors' });
  });

  it('reads a leaf sandbox, which is the question worth answering', () => {
    const out = planRead({ verb: 'get', resource: 'events', target: 'koala-ws-leaf-1' }, mine);
    expect((out as { namespace: string }).namespace).toBe('koala-ws-leaf-1');
  });

  it('allows cluster-scoped reads with no namespace and no target', () => {
    expect(planRead({ verb: 'top', resource: 'nodes' }, mine)).toEqual({ argv: ['top', 'nodes'] });
    expect(planRead({ verb: 'get', resource: 'nodes' }, [])).toEqual({ argv: ['get', 'nodes'] });
  });

  it('asks for a target rather than defaulting to one', () => {
    const out = planRead({ verb: 'get', resource: 'pods' }, mine) as { refused: string };
    expect(out.refused).toMatch(/which deployment or leaf sandbox/i);
  });
});

describe('which namespaces are readable at all', () => {
  it('is the caller\'s deployments plus their own sandboxes', () => {
    const deployments = [
      { name: 'koala-vectors', namespace: 'koala-vectors', ownerId: 'u1' },
      { name: 'someone-else', namespace: 'someone-else', ownerId: 'u2' },
    ];

    expect(readableNamespaces(deployments, ['koala-ws-a'], 'u1')).toEqual(['koala-vectors', 'koala-ws-a']);
  });

  it('excludes another owner\'s deployment even when the name is known', () => {
    const deployments = [{ name: 'theirs', namespace: 'theirs', ownerId: 'u2' }];
    expect(readableNamespaces(deployments, [], 'u1')).toEqual([]);
    expect(planRead({ verb: 'get', resource: 'pods', target: 'theirs' }, [])).toHaveProperty('refused');
  });
});
