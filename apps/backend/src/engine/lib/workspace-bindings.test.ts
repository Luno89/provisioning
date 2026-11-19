import { describe, it, expect } from 'vitest';
import { egressForBindings } from './workspace-spec.js';
import { describable } from '../../infrastructure/lib/binding-resolve.js';
import { readBindingCredentials } from '../../projects/lib/binding-project.js';
import type { ResolvedBinding } from '../../infrastructure/lib/binding-resolve.js';

const binding = (over: Partial<ResolvedBinding> = {}): ResolvedBinding => ({
  name: 'qdrant',
  type: 'qdrant',
  host: 'qdrant.koala-vectors.svc.cluster.local',
  port: 6333,
  source: { secretName: 'qdrant-secret', namespace: 'koala-vectors', keys: { 'api-key': 'qdrant-api-key' } },
  ...over,
});

describe('the egress a binding earns', () => {
  it('opens the namespace and port the binding resolved to', () => {
    expect(egressForBindings([binding()])).toEqual([{ namespace: 'koala-vectors', ports: [6333] }]);
  });

  it('uses the namespace form, never a CIDR', () => {
    const [rule] = egressForBindings([binding()]);
    expect(rule).toHaveProperty('namespace');
    expect(rule).not.toHaveProperty('cidr');
  });

  it('opens the pod port, not the NodePort', () => {
    expect(egressForBindings([binding()])[0]!.ports).toEqual([6333]);
  });

  it('merges ports of two bindings in one namespace, rather than emitting two rules', () => {
    const rules = egressForBindings([binding(), binding({ name: 'q2', port: 6334 })]);
    expect(rules).toEqual([{ namespace: 'koala-vectors', ports: [6333, 6334] }]);
  });

  it('opens NOTHING when nothing was declared', () => {
    expect(egressForBindings([])).toEqual([]);
  });
});

describe('reading the source credential', () => {
  const secretJson = JSON.stringify({
    data: { 'qdrant-api-key': Buffer.from('hunter2').toString('base64'), 'unrelated': 'eA==' },
  });

  it('decodes only the keys the binding declared', async () => {
    const creds = await readBindingCredentials(async () => secretJson, binding());
    expect(creds).toEqual({ 'api-key': 'hunter2' });
  });

  it('reads from the provider namespace, by name', async () => {
    let saw: string[] = [];
    await readBindingCredentials(async (args) => { saw = args; return secretJson; }, binding());
    expect(saw).toEqual(['get', 'secret', 'qdrant-secret', '-n', 'koala-vectors', '-o', 'json']);
  });

  it('yields nothing rather than throwing when the Secret is unreadable', async () => {
    expect(await readBindingCredentials(async () => { throw new Error('forbidden'); }, binding())).toEqual({});
    expect(await readBindingCredentials(async () => 'not json', binding())).toEqual({});
  });
});

describe('what the agent is told', () => {
  it('never shows the source Secret key mapping', () => {
    const d = describable(binding());
    expect(d.keys).toEqual(['api-key']);
    expect(JSON.stringify(d)).not.toContain('qdrant-api-key');
    expect(JSON.stringify(d)).not.toContain('qdrant-secret');
  });
});
