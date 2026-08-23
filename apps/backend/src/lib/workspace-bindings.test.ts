import { describe, it, expect } from 'vitest';
import { buildWorkspaceManifests, egressForBindings, workspaceNamespace } from './workspace-spec.js';
import { describable } from './binding-resolve.js';
import { bindingSecretName, SERVICE_BINDING_ROOT } from './service-binding.js';
import { readBindingCredentials } from './binding-project.js';
import type { ResolvedBinding } from './binding-resolve.js';

/**
 * ── WHAT THIS FILE IS GUARDING ──
 *
 * Two projects burned roughly 3.7M tokens on leaves that could not reach the services they were
 * written against. The agent did the right thing every time: it looked in `$SERVICE_BINDING_ROOT`
 * first, found nothing, searched the filesystem, guessed five DNS names, got one right, and was
 * refused by the NetworkPolicy — then spent fourteen steps debugging its own client.
 *
 * So the properties below are not stylistic. A binding must be reachable AND mounted, and a
 * dependency that was never declared must open nothing at all.
 */

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
    /**
     * Not a preference. kube-proxy DNATs a NodePort before the policy is evaluated, so by the time
     * the rule is checked the destination is the backing pod's IP and a rule naming the node fails
     * CLOSED — which is the silent version of the failure this whole change exists to end.
     */
    const [rule] = egressForBindings([binding()]);
    expect(rule).toHaveProperty('namespace');
    expect(rule).not.toHaveProperty('cidr');
  });

  it('opens the pod port, not the NodePort', () => {
    // 6333 is what a pod answers on; 31318 is what the node publishes. A policy naming the NodePort
    // matches nothing.
    expect(egressForBindings([binding()])[0]!.ports).toEqual([6333]);
  });

  it('merges ports of two bindings in one namespace, rather than emitting two rules', () => {
    const rules = egressForBindings([binding(), binding({ name: 'q2', port: 6334 })]);
    expect(rules).toEqual([{ namespace: 'koala-vectors', ports: [6333, 6334] }]);
  });

  it('opens NOTHING when nothing was declared', () => {
    // The property that keeps this from being a blanket hole: no declaration, no reachability.
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
    // A credential an app can edit is one it can corrupt.
    expect(mount.readOnly).toBe(true);
  });

  it('sets SERVICE_BINDING_ROOT explicitly rather than relying on the convention', () => {
    // The agent that failed read the variable first. Finding it unset is what sent it hunting.
    const env = pod.spec.containers[0].env.find((e: any) => e.name === 'SERVICE_BINDING_ROOT');
    expect(env.value).toBe(SERVICE_BINDING_ROOT);
  });

  it('ships the Secret in the same document as the Pod', () => {
    /**
     * `WorkspaceService.create` applies one document so a partial create is impossible. A Pod whose
     * binding Secret was applied separately can start before it exists, and the mount fails in a
     * way that looks exactly like the bug being fixed.
     */
    const secret = kind('Secret')[0];
    expect(secret.metadata.name).toBe(bindingSecretName('qdrant'));
    expect(secret.metadata.namespace).toBe(workspaceNamespace(spec.leafId));
    expect(secret.stringData['api-key']).toBe('secret-value');
  });

  it('keeps the default-deny policy and adds only the declared hole', () => {
    const policy = kind('NetworkPolicy')[0];
    expect(policy.spec.ingress).toEqual([]);
    // DNS, plus exactly one namespace selector. Nothing else became reachable.
    expect(policy.spec.egress).toHaveLength(2);
    expect(policy.spec.egress[1].to[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name'])
      .toBe('koala-vectors');
  });

  it('changes nothing for a leaf with no bindings', () => {
    // Every existing leaf takes this path; it must be identical to before.
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
    // A binding is the subset needed to connect, not a copy of a service's secrets.
    const creds = await readBindingCredentials(async () => secretJson, binding());
    expect(creds).toEqual({ 'api-key': 'hunter2' });
  });

  it('reads from the provider namespace, by name', async () => {
    let saw: string[] = [];
    await readBindingCredentials(async (args) => { saw = args; return secretJson; }, binding());
    expect(saw).toEqual(['get', 'secret', 'qdrant-secret', '-n', 'koala-vectors', '-o', 'json']);
  });

  it('yields nothing rather than throwing when the Secret is unreadable', async () => {
    // The sandbox still gets host and port, which is a diagnosable state. Throwing would cost the
    // leaf its whole run over a credential it might not even need.
    expect(await readBindingCredentials(async () => { throw new Error('forbidden'); }, binding())).toEqual({});
    expect(await readBindingCredentials(async () => 'not json', binding())).toEqual({});
  });
});

describe('what the agent is told', () => {
  it('never shows the source Secret key mapping', () => {
    // `source.keys` maps to the provider's internal key names. The agent needs the filenames it
    // will find, and nothing about where they came from.
    const d = describable(binding());
    expect(d.keys).toEqual(['api-key']);
    expect(JSON.stringify(d)).not.toContain('qdrant-api-key');
    expect(JSON.stringify(d)).not.toContain('qdrant-secret');
  });
});
