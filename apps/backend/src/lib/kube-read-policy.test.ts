import { describe, it, expect } from 'vitest';
import { planRead, readableNamespaces, READ_VERBS } from './kube-diagnostics.js';

/**
 * ── THE POLICY IS THE FEATURE ──
 *
 * Widening Koala's cluster reads is only safe because what it may do is a condition on an argv
 * array rather than a sentence in a prompt. A refusal an agent can argue with is one that will
 * eventually be argued with; these cannot be.
 *
 * Two properties matter most and are tested first: no verb that changes anything, and no path to a
 * Secret. Everything else is scoping, which this codebase already treats as the security boundary
 * (`namespaceFor`, `binding-resolve.ts`).
 */

const mine = ['koala-vectors', 'koala-ws-leaf-1'];

describe('what it will never do', () => {
  it('refuses every mutating verb', () => {
    // Not a list to keep in sync — anything absent from READ_VERBS is refused by construction.
    for (const verb of ['delete', 'patch', 'apply', 'edit', 'scale', 'exec', 'cp', 'port-forward', 'drain']) {
      const out = planRead({ verb, resource: 'pods', target: 'koala-vectors' }, mine);
      expect(out).toHaveProperty('refused');
      expect((out as { refused: string }).refused).toMatch(/not a readable action/);
    }
  });

  it('refuses Secrets and ConfigMaps, and says why', () => {
    /**
     * The two that would undo everything else. A Secret is the credential material this platform
     * binds into apps; a ConfigMap routinely holds a connection string. The refusal names them so
     * the agent does not simply try the other one next.
     */
    for (const resource of ['secret', 'secrets', 'configmap', 'configmaps']) {
      const out = planRead({ verb: 'get', resource, target: 'koala-vectors' }, mine) as { refused: string };
      expect(out.refused).toMatch(/cannot be read/i);
      expect(out.refused).toMatch(/credentials/i);
    }
  });

  it('refuses a namespace that is not the caller\'s', () => {
    // The rule `namespaceFor` already states for logs: a namespace taken from a tool call is every
    // other namespace on the cluster.
    const out = planRead({ verb: 'get', resource: 'pods', target: 'kube-system' }, mine);
    expect(out).toHaveProperty('refused');
  });

  it('cannot smuggle a namespace through the object name', () => {
    // `-n` is added by the planner, never by the caller. A name that looks like a flag is rejected
    // before it can become one.
    for (const name of ['-n', '--namespace=kube-system', '-n kube-system', '../secrets']) {
      expect(planRead({ verb: 'get', resource: 'pods', name, target: 'koala-vectors' }, mine))
        .toHaveProperty('refused');
    }
  });

  it('never emits a verb outside the allowlist, whatever it is asked', () => {
    // The structural claim, checked rather than asserted.
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
    // "Why did my leaf fail" used to require reading Mongo by hand.
    const out = planRead({ verb: 'get', resource: 'events', target: 'koala-ws-leaf-1' }, mine);
    expect((out as { namespace: string }).namespace).toBe('koala-ws-leaf-1');
  });

  it('allows cluster-scoped reads with no namespace and no target', () => {
    // Capacity and topology expose no tenant data, so they need no scope.
    expect(planRead({ verb: 'top', resource: 'nodes' }, mine)).toEqual({ argv: ['top', 'nodes'] });
    expect(planRead({ verb: 'get', resource: 'nodes' }, [])).toEqual({ argv: ['get', 'nodes'] });
  });

  it('asks for a target rather than defaulting to one', () => {
    // Defaulting would silently read something the caller did not name.
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
    // And so the plan refuses it, which is the property that actually matters.
    expect(planRead({ verb: 'get', resource: 'pods', target: 'theirs' }, [])).toHaveProperty('refused');
  });
});
