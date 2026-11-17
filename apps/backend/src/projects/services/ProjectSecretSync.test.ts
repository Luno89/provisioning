import { describe, it, expect, vi } from 'vitest';
import { OPERATOR_VERSION, syncProjectSecrets } from './ProjectSecretSync.js';
import { decryptValue, encryptValue } from '../../platform/lib/crypto.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';

const MASTER = 'test-master-key-that-is-at-least-32-characters';

function world(operatorInstalled: boolean | string, readerAlive = true) {
  const helm: string[][] = [];
  const applied: string[] = [];
  const kubectl: string[][] = [];
  const infra = {
    runHelm: vi.fn(async (args: string[]) => {
      helm.push(args);
      if (args[0] === 'list') {
        if (!operatorInstalled) return '[]';
        return JSON.stringify([{ name: 'infisical-operator', chart: `secrets-operator-${operatorInstalled === true ? OPERATOR_VERSION : operatorInstalled}` }]);
      }
      return '';
    }),
    runKubectl: vi.fn(async (args: string[]) => { kubectl.push(args); return ''; }),
    applyManifest: vi.fn(async (manifest: string) => { applied.push(manifest); return ''; }),
  };
  const vault = {
    resolveBaseUrl: vi.fn(async () => 'http://vault.test:8080'),
    workspaceIdFor: vi.fn(async () => 'ws-1'),
    createProjectReader: vi.fn(async () => ({ clientId: 'cid', clientSecret: 'reader-secret-sentinel' })),
    readerWorks: vi.fn(async () => readerAlive),
  };
  const saved: ProjectMetadata[] = [];
  const projects = { saveProject: vi.fn(async (project: ProjectMetadata) => { saved.push(project); }) };
  return { infra, vault, projects, helm, applied, kubectl, saved };
}

const project: ProjectMetadata = { id: 'p1', name: 'billing', ownerId: 'u1', appType: 'gitapp', createdAt: 'now' };
const reach = { clusterId: 'machine-dev1', kind: 'koala' as const };

describe('syncProjectSecrets', () => {
  it('installs the operator when absent, mints a reader once, and applies the credential and the InfisicalSecret', async () => {
    const w = world(false);
    const out = await syncProjectSecrets({ ...w, masterKey: MASTER }, { project, namespace: 'billing', kubeconfig: '/tmp/kubeconfig-dev-1', reach });

    expect(out).toEqual({ hostAPI: 'http://vault.test:8080', operator: 'installed' });
    expect(w.applied[1]).toContain('hostAPI: "http://vault.test:8080/api"');
    expect(w.helm[1]).toEqual(expect.arrayContaining(['upgrade', '--install', 'infisical-operator', 'secrets-operator']));
    expect(w.vault.createProjectReader).toHaveBeenCalledTimes(1);
    expect(decryptValue(w.saved[0]!.infisicalReaderEnc!, MASTER)).toContain('reader-secret-sentinel');
    expect(w.applied).toHaveLength(2);
    expect(w.applied[0]).toContain('kind: Secret');
    expect(w.applied[1]).toContain('kind: InfisicalSecret');
    expect(JSON.stringify(w.kubectl)).not.toContain('reader-secret-sentinel');
  });

  it('leaves an operator already at the version Koala pins, and upgrades one at any other to it', async () => {
    const current = world(true);
    expect((await syncProjectSecrets({ ...current, masterKey: MASTER }, { project, namespace: 'billing', kubeconfig: '/tmp/k', reach })).operator).toBe('present');
    expect(current.helm.filter((args) => args[0] === 'upgrade')).toEqual([]);
    const older = world('v0.11.10');
    expect((await syncProjectSecrets({ ...older, masterKey: MASTER }, { project, namespace: 'billing', kubeconfig: '/tmp/k', reach })).operator).toBe('upgraded');
    expect(older.helm.find((args) => args[0] === 'upgrade')).toEqual(expect.arrayContaining(['upgrade', '--install', 'infisical-operator', 'secrets-operator', '--version', OPERATOR_VERSION]));
  });

  it('reuses the reader stored on the project instead of minting another', async () => {
    const first = world(true);
    await syncProjectSecrets({ ...first, masterKey: MASTER }, { project, namespace: 'billing', kubeconfig: 'k', reach });
    const again = world(true);
    const out = await syncProjectSecrets({ ...again, masterKey: MASTER }, { project: first.saved[0]!, namespace: 'billing', kubeconfig: 'k', reach });

    expect(out.operator).toBe('present');
    expect(again.vault.createProjectReader).not.toHaveBeenCalled();
    expect(again.applied[0]).toContain('reader-secret-sentinel');
  });

  it('mints a new reader when the vault refuses the stored one, and stores and applies that one', async () => {
    const stale = { ...project, infisicalReaderEnc: encryptValue(JSON.stringify({ clientId: 'old', clientSecret: 'dead-reader' }), MASTER) };
    const w = world(true, false);
    await syncProjectSecrets({ ...w, masterKey: MASTER }, { project: stale, namespace: 'billing', kubeconfig: 'k', reach });

    expect(w.vault.readerWorks).toHaveBeenCalledWith({ clientId: 'old', clientSecret: 'dead-reader' });
    expect(w.vault.createProjectReader).toHaveBeenCalledTimes(1);
    expect(decryptValue(w.saved[0]!.infisicalReaderEnc!, MASTER)).toContain('reader-secret-sentinel');
    expect(w.applied[0]).toContain('reader-secret-sentinel');
    expect(w.applied.join('')).not.toContain('dead-reader');
  });

  it('refuses a cluster that cannot reach the vault before touching it', async () => {
    const w = world(true);
    await expect(syncProjectSecrets({ ...w, masterKey: MASTER }, { project, namespace: 'billing', kubeconfig: 'k', reach: { clusterId: 'machine-box', kind: 'machine' } }))
      .rejects.toThrow('not reachable');
    expect(w.helm).toHaveLength(0);
    expect(w.applied).toHaveLength(0);
  });
});
