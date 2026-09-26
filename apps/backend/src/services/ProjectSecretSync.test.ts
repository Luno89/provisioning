import { describe, it, expect, vi } from 'vitest';
import { syncProjectSecrets } from './ProjectSecretSync.js';
import { decryptValue } from '../lib/crypto.js';
import type { ProjectMetadata } from '../lib/types.js';

const MASTER = 'test-master-key-that-is-at-least-32-characters';

function world(operatorInstalled: boolean) {
  const helm: string[][] = [];
  const applied: string[] = [];
  const kubectl: string[][] = [];
  const infra = {
    runHelm: vi.fn(async (args: string[]) => {
      helm.push(args);
      if (args[0] === 'status' && !operatorInstalled) throw new Error('release: not found');
      return '';
    }),
    runKubectl: vi.fn(async (args: string[]) => { kubectl.push(args); return ''; }),
    applyManifest: vi.fn(async (manifest: string) => { applied.push(manifest); return ''; }),
  };
  const vault = {
    workspaceIdFor: vi.fn(async () => 'ws-1'),
    createProjectReader: vi.fn(async () => ({ clientId: 'cid', clientSecret: 'reader-secret-sentinel' })),
  };
  const saved: ProjectMetadata[] = [];
  const projects = { saveProject: vi.fn(async (project: ProjectMetadata) => { saved.push(project); }) };
  return { infra, vault, projects, helm, applied, kubectl, saved };
}

const project: ProjectMetadata = { id: 'p1', name: 'billing', ownerId: 'u1', appType: 'gitapp', createdAt: 'now' };
const target = { clusterName: 'dev-1', provider: 'k3d', isMock: false };

describe('syncProjectSecrets', () => {
  it('installs the operator when absent, mints a reader once, and applies the credential and the InfisicalSecret', async () => {
    const w = world(false);
    const out = await syncProjectSecrets({ ...w, masterKey: MASTER }, { project, namespace: 'billing', kubeconfig: '/tmp/kubeconfig-dev-1', target });

    expect(out).toEqual({ hostAPI: 'http://host.k3d.internal:31738', operator: 'installed' });
    expect(w.helm[1]).toEqual(expect.arrayContaining(['upgrade', '--install', 'infisical-operator', 'secrets-operator']));
    expect(w.vault.createProjectReader).toHaveBeenCalledTimes(1);
    expect(decryptValue(w.saved[0]!.infisicalReaderEnc!, MASTER)).toContain('reader-secret-sentinel');
    expect(w.applied).toHaveLength(2);
    expect(w.applied[0]).toContain('kind: Secret');
    expect(w.applied[1]).toContain('kind: InfisicalSecret');
    expect(JSON.stringify(w.kubectl)).not.toContain('reader-secret-sentinel');
  });

  it('reuses the reader stored on the project instead of minting another', async () => {
    const first = world(true);
    await syncProjectSecrets({ ...first, masterKey: MASTER }, { project, namespace: 'billing', kubeconfig: 'k', target });
    const again = world(true);
    const out = await syncProjectSecrets({ ...again, masterKey: MASTER }, { project: first.saved[0]!, namespace: 'billing', kubeconfig: 'k', target });

    expect(out.operator).toBe('present');
    expect(again.vault.createProjectReader).not.toHaveBeenCalled();
    expect(again.applied[0]).toContain('reader-secret-sentinel');
  });

  it('refuses a cluster that cannot reach the vault before touching it', async () => {
    const w = world(true);
    await expect(syncProjectSecrets({ ...w, masterKey: MASTER }, { project, namespace: 'billing', kubeconfig: 'k', target: { clusterName: 'box', provider: 'remote', isMock: false } }))
      .rejects.toThrow('not reachable');
    expect(w.helm).toHaveLength(0);
    expect(w.applied).toHaveLength(0);
  });
});
