import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, it, vi } from 'vitest';
import { removalHoldOf } from '../lib/app-namespace.js';
import { InfrastructureService } from './InfrastructureService.js';

const k3s = inject('k3s');

function onK3s() {
  const kubeconfig = join(mkdtempSync(join(tmpdir(), 'koala-namespaces-')), 'admin.yaml');
  writeFileSync(kubeconfig, k3s.admin, { mode: 0o600 });
  const infra = new InfrastructureService();
  return { infra, kubeconfig, kubectl: (...args: string[]) => infra.runKubectl(args, kubeconfig) };
}

describe('removing an app\'s namespace on a real cluster', () => {
  it('returns once the namespace and everything in it are gone', async () => {
    const { infra, kubeconfig, kubectl } = onK3s();
    await kubectl('create', 'namespace', 'leaving-1a2b3c');
    await kubectl('create', 'configmap', 'settings', '-n', 'leaving-1a2b3c', '--from-literal=a=b');
    await infra.waitForNamespaceDeletion('leaving-1a2b3c', kubeconfig);
    expect(await kubectl('get', 'namespace', 'leaving-1a2b3c', '--ignore-not-found', '-o', 'name')).toBe('');
  }, 120_000);

  it('waits on a finalizer holding the namespace without clearing it, says what holds it, and ends once its controller lets go', async () => {
    const { infra, kubeconfig, kubectl } = onK3s();
    await kubectl('create', 'namespace', 'held-4d5e6f');
    await infra.applyManifest('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: held\n  namespace: held-4d5e6f\n  finalizers: [koala.test/hold]\n', kubeconfig);
    let ended = false;
    const waiting = infra.waitForNamespaceDeletion('held-4d5e6f', kubeconfig).then(() => { ended = true; });

    const hold = await vi.waitFor(async () => {
      const found = removalHoldOf(JSON.parse(await kubectl('get', 'namespace', 'held-4d5e6f', '-o', 'json')) as unknown);
      if (!found?.includes('koala.test/hold')) throw new Error(`not held yet: ${found}`);
      return found;
    }, { timeout: 60_000, interval: 500 });
    expect(hold).toMatch(/^it is being removed, and Kubernetes is waiting on: .*koala\.test\/hold/);
    expect(ended).toBe(false);
    expect(await kubectl('get', 'configmap', 'held', '-n', 'held-4d5e6f', '-o', 'jsonpath={.metadata.finalizers}')).toContain('koala.test/hold');

    await kubectl('patch', 'configmap', 'held', '-n', 'held-4d5e6f', '--type=merge', '-p', '{"metadata":{"finalizers":null}}');
    await waiting;
    expect(await kubectl('get', 'namespace', 'held-4d5e6f', '--ignore-not-found', '-o', 'name')).toBe('');
  }, 120_000);
});
