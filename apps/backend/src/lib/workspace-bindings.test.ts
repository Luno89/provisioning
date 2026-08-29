import { describe, it, expect } from 'vitest';
import { buildWorkspaceManifests, egressForBindings, workspaceNamespace } from './workspace-spec.js';
import { describable } from './binding-resolve.js';
import { bindingSecretName, SERVICE_BINDING_ROOT } from './service-binding.js';
import { readBindingCredentials } from './binding-project.js';
import type { ResolvedBinding } from './binding-resolve.js';

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

describe('what reaches the sandbox', () => {
  const spec = {
    leafId: '11111111-2222-3333-4444-555555555555',
    ownerId: 'u1',
    egress: egressForBindings([binding()]),
    bindings: [{ name: 'qdrant', files: { type: 'qdrant', host: 'h', port: '6333', 'api-key': 'secret-value' } }],
  };
  const manifests = buildWorkspaceManifests(spec);
  const kind = (k: string) => manifests.filter((m) => (m as any).kind === k) as any[];
  const pod = kind('Pod')[0];

  it('mounts the binding at $SERVICE_BINDING_ROOT, read-only', () => {
    const mount = pod.spec.containers[0].volumeMounts.find((m: any) => m.mountPath.includes('bindings'));
    expect(mount.mountPath).toBe(`${SERVICE_BINDING_ROOT}/qdrant`);
    expect(mount.readOnly).toBe(true);
  });

  it('sets SERVICE_BINDING_ROOT explicitly rather than relying on the convention', () => {
    const env = pod.spec.containers[0].env.find((e: any) => e.name === 'SERVICE_BINDING_ROOT');
    expect(env.value).toBe(SERVICE_BINDING_ROOT);
  });

  it('ships the Secret in the same document as the Pod', () => {
    const secret = kind('Secret')[0];
    expect(secret.metadata.name).toBe(bindingSecretName('qdrant'));
    expect(secret.metadata.namespace).toBe(workspaceNamespace(spec.leafId));
    expect(secret.stringData['api-key']).toBe('secret-value');
  });

  it('keeps the default-deny policy and adds only the declared hole', () => {
    const policy = kind('NetworkPolicy')[0];
    expect(policy.spec.ingress).toEqual([]);
    expect(policy.spec.egress).toHaveLength(2);
    expect(policy.spec.egress[1].to[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name'])
      .toBe('koala-vectors');
  });

  it('changes nothing for a leaf with no bindings', () => {
    const plain = buildWorkspaceManifests({ leafId: spec.leafId, ownerId: 'u1' }) as any[];
    expect(plain.filter((m) => m.kind === 'Secret')).toEqual([]);
    const p = plain.find((m) => m.kind === 'Pod');
    expect(p.spec.containers[0].env.some((e: any) => e.name === 'SERVICE_BINDING_ROOT')).toBe(false);
    expect(p.spec.volumes.map((v: any) => v.name)).toEqual(['work', 'tmp']);
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
