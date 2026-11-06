import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import axios from 'axios';
import { mock } from 'vitest-mock-extended';
import { mountRouter, TEST_USER } from '../../platform/routes/test-harness.js';
import { authorize, type Principal } from '../../platform/lib/permissions.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { ClusterMetadata, PipelineRunMetadata } from '../../platform/lib/types.js';
import type { InfrastructureService } from '../../infrastructure/index.js';
import { ClusterService } from '../../infrastructure/services/ClusterService.js';
import { treeTypeOfProject } from '../../projects/lib/tree-types.js';
import { createSlotCluster } from '../../extensions/releases/slot-cluster.js';
import { ODOO_RELEASE_ADAPTER } from '../../extensions/odoo/release-adapter.js';
import { latestBuildOf, projectMajor } from '../lib/client-import.js';
import { releaseHowOf } from '../lib/release-run.js';
import { ClientImportService } from '../services/ClientImportService.js';
import { OdooReleaseService } from '../services/OdooReleaseService.js';
import { releaseRunsOnTemporal, type ReleaseRunsOnTemporal } from '../testing/release-runs-on-temporal.js';
import { clientImportRouter } from './client-import.js';

const KEY = 'client-import-route-test-key' as never;
const NOW = '2026-10-10T09:00:00.000Z';
const quiet = { validateStatus: () => true };

let temporal: ReleaseRunsOnTemporal;
beforeAll(async () => { temporal = await releaseRunsOnTemporal(); }, 0);
afterAll(async () => { await temporal?.close(); });

const ownedProject = (db: Database) => async (id: string, principal: Principal) => {
  const project = (await db.projects.getProjects()).find((entry) => entry.id === id);
  return project && authorize(principal, 'see', { kind: 'project', ownerId: project.ownerId }).allowed ? project : undefined;
};

function cluster() {
  const received: number[] = [];
  const asked: string[] = [];
  let backupFrom = '20.0';
  const infra = mock<InfrastructureService>();
  infra.applyManifest.mockResolvedValue('');
  infra.runKubectl.mockImplementation(async (args) => {
    asked.push(args.join(' '));
    if (args.includes('unzip')) return JSON.stringify({ major_version: backupFrom, modules: { base: `${backupFrom}.1.3`, sale: `${backupFrom}.1.0` } });
    if (args.includes('jsonpath={.status.phase}')) return 'Running';
    return '';
  });
  infra.pipeKubectl.mockImplementation(async (_args, _kubeconfig, input) => {
    let size = 0;
    for await (const chunk of input) size += (chunk as Buffer).length;
    received.push(size);
    return '';
  });
  return { infra, received, asked, backupFrom: (version: string) => { backupFrom = version; } };
}

async function harness() {
  const seam = cluster();
  let releases: OdooReleaseService | undefined;
  const h = await mountRouter({
    prefix: '/api/projects',
    router: (db) => {
      const clusters = new ClusterService(db, seam.infra, KEY, { koalaMachineId: undefined });
      releases = new OdooReleaseService({
        store: db,
        runs: temporal.runs,
        how: async (project) => releaseHowOf(project, await treeTypeOfProject(db.projects, project), true),
        chartAt: async () => true,
        clusterById: (id) => clusters.getByIdUnscoped(id),
        now: () => NOW,
        newId: () => 'r1',
      });
      const imports = new ClientImportService({
        projects: () => db.projects.getProjects(),
        saveProject: (patch) => db.projects.saveProjectInfo(patch),
        clusterById: (id) => clusters.getByIdUnscoped(id),
        adapterOf: async (project) => (releaseHowOf(project, await treeTypeOfProject(db.projects, project), true).app === ODOO_RELEASE_ADAPTER.id ? ODOO_RELEASE_ADAPTER : undefined),
        cluster: createSlotCluster({
          infra: seam.infra,
          repo: async () => { throw new Error('a client\'s database reads no build files'); },
          registry: async () => ({ hosts: { push: 'registry.koala.test', pull: 'registry.koala.test' }, username: 'koala-pull', password: 'pull-token' }),
          syncVault: async () => { throw new Error('a client\'s database syncs no vault'); },
        }),
        odooVersion: async (project) => {
          const tree = (await db.projects.getTrees()).find((entry) => entry.ownerId === project.ownerId && entry.projectIds?.[0] === project.id);
          return tree?.version ? projectMajor(tree.version) : undefined;
        },
        latestBuild: async (project) => latestBuildOf(await db.releases.getPipelineRuns(), project.id),
        releases,
        now: () => NOW,
      });
      return clientImportRouter({ imports, getOwnedProject: ownedProject(db) });
    },
  });
  await h.db.infrastructure.saveClusterInfo({ id: 'c1', name: 'shop-machine', provider: 'hetzner', status: 'healthy', kubeconfigPath: '/kube/shop-machine', ownerId: TEST_USER.id } as ClusterMetadata);
  await h.db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: TEST_USER.id, appType: 'gitapp', giteaOwner: 'koala-test-user', giteaRepo: 'shop', targetClusterId: 'c1', releaseName: 'shop-1a2b3c', createdAt: 'then' });
  await h.db.projects.saveProject({ id: 'p2', name: 'Theirs', ownerId: 'someone-else', appType: 'gitapp', targetClusterId: 'c1', createdAt: 'then' });
  await h.db.projects.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'Shop', type: 'odoo', version: '20', projectIds: ['p1'], createdAt: 'then', updatedAt: 'then' } as never);
  return {
    h,
    seam,
    close: async () => {
      await releases?.stop();
      await temporal.end('p1');
      await h.close();
    },
  };
}

describe('a client\'s database for a project', () => {
  it('streams the whole upload to the service with its size and mode, as the project\'s owner', async () => {
    const { h, seam, close } = await harness();
    const project = async (id: string) => (await h.db.projects.getProjects()).find((entry) => entry.id === id)!;
    const zip = Buffer.alloc(3 * 1024 * 1024, 7);
    const put = await axios.put(h.url('/api/projects/p1/import?mode=copy'), zip, { headers: { 'Content-Type': 'application/zip' }, maxBodyLength: Infinity, ...quiet });
    expect(put.status).toBe(201);
    expect(put.data).toEqual({ state: 'uploaded', mode: 'copy', bytes: zip.length, version: '20.0', modules: ['base', 'sale'], at: NOW });
    expect(seam.received).toEqual([zip.length]);
    expect((await project('p1')).clientImport).toEqual(put.data);
    seam.backupFrom('17.0');
    const refused = await axios.put(h.url('/api/projects/p1/import?mode=live'), Buffer.from('PK'), { headers: { 'Content-Type': 'application/zip' }, ...quiet });
    const why = 'the backup is from Odoo 17.0, and this project runs Odoo 20.0; moving a database from one Odoo version to another is a step of its own';
    expect([refused.status, refused.data]).toEqual([409, { error: why }]);
    expect(seam.asked).toContain('-n shop-1a2b3c exec shop-1a2b3c-import-holder -- rm -f /import/backup.zip /import/backup.zip.part');
    expect((await axios.put(h.url('/api/projects/p2/import'), Buffer.from('PK'), { headers: { 'Content-Type': 'application/zip' }, ...quiet })).status).toBe(404);
    expect(seam.received).toEqual([zip.length, 2]);
    expect((await project('p2')).clientImport).toBeUndefined();
    expect((await axios.get(h.url('/api/projects/p1/import'))).data).toEqual({ import: { state: 'refused', mode: 'live', bytes: 2, version: '17.0', reason: why, at: NOW }, open: true });
    await h.db.releases.savePipelineRunInfo({ id: 'b1', projectId: 'p1', commitSha: 'c0ffee1234', imageTag: 'reg/shop:c0ffee1234', status: 'succeeded', startedAt: 'then' } as PipelineRunMetadata);
    expect((await axios.delete(h.url('/api/projects/p1/import'))).data).toEqual({ released: true });
    expect((await project('p1')).clientImport).toBeNull();
    expect(temporal.started.map((run) => [run.agent, run.projectId, (run.inputs.build as { releaseId: string }).releaseId])).toEqual([['release', 'p1', 'r1']]);
    await close();
  });
});
