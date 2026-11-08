import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { authorize, type Principal } from '../../platform/lib/permissions.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { ClusterMetadata, PipelineRunMetadata, ProjectMetadata } from '../../platform/lib/types.js';
import { ClusterService } from '../../infrastructure/services/ClusterService.js';
import { testClusterAccess } from '../../infrastructure/testing/cluster-access.js';
import { GiteaService } from '../../projects/services/GiteaService.js';
import { ProjectRepoService } from '../../projects/services/ProjectRepoService.js';
import { projectSecretsFor } from '../../projects/services/ProjectSecretsService.js';
import { treeTypeOfProject } from '../../projects/lib/tree-types.js';
import type { GiteaAccount } from '../../projects/lib/projects.js';
import { startRealGitea, type RealGitea } from '../../projects/testing/real-gitea.js';
import { ODOO_RELEASE_SECRETS, type OdooRelease } from '../lib/odoo-release.js';
import { HELD_FOR_CLIENT } from '../lib/client-import.js';
import { releaseHowOf } from '../lib/release-run.js';
import { OdooReleaseService } from '../services/OdooReleaseService.js';
import { releaseRunsOnTemporal, type ReleaseRunsOnTemporal } from '../testing/release-runs-on-temporal.js';
import { releasesRouter } from './releases.js';

const KEY = 'releases-route-test-key' as never;
const quiet = { validateStatus: () => true };
const NOW = '2026-10-10T09:00:00.000Z';

let gitea: RealGitea;
let giteaService: GiteaService;
let dataDir: string;
let account: GiteaAccount;
let owner: string;
let before: string;
let after: string;
let temporal: ReleaseRunsOnTemporal;

const giteaApi = async (route: string): Promise<unknown> => {
  const answer = await fetch(`${gitea.url}/api/v1${route}`, { headers: { Authorization: `Basic ${Buffer.from(`provisioning-bot:${gitea.adminPassword}`).toString('base64')}` } });
  if (!answer.ok) throw new Error(`Gitea answered ${route} with ${answer.status}: ${await answer.text()}`);
  return answer.json();
};
const headOf = async (repo: string): Promise<string> => ((await giteaApi(`/repos/${owner}/${repo}/branches/main`)) as { commit: { id: string } }).commit.id;

beforeAll(async () => {
  temporal = await releaseRunsOnTemporal();
  gitea = await startRealGitea();
  dataDir = await mkdtemp(path.join(tmpdir(), 'releases-route-gitea-'));
  await writeFile(path.join(dataDir, '.gitea-admin-password'), gitea.adminPassword);
  giteaService = new GiteaService(KEY, { url: gitea.url }, { dataDir });
  const setUp = await testDatabase();
  owner = (await new ProjectRepoService(setUp, giteaService, KEY).ensureAccountFor(TEST_USER.id)).username;
  account = (await setUp.projects.getGiteaAccount(TEST_USER.id))!;
  await giteaService.createRepoForUser(owner, 'shop');
  await giteaService.commitFiles(owner, 'shop', [{ path: 'addons/x.py', content: 'value = 1\n' }], 'The release that is live');
  before = await headOf('shop');
  await giteaService.commitFiles(owner, 'shop', [{ path: 'addons/x.py', content: 'value = 2\n' }], 'The release after it');
  after = await headOf('shop');
}, 0);

afterAll(async () => {
  await gitea?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await temporal?.close();
});

const ownedProject = (db: Database) => async (id: string, principal: Principal) => {
  const project = (await db.projects.getProjects()).find((entry) => entry.id === id);
  return project && authorize(principal, 'see', { kind: 'project', ownerId: project.ownerId }).allowed ? project : undefined;
};

const release = (over: Partial<OdooRelease> & Pick<OdooRelease, 'id' | 'state'>): OdooRelease => ({
  ownerId: TEST_USER.id, projectId: 'p1', pipelineRunId: 'b1', commit: after, image: 'reg/shop:two', host: 'shop-1a2b3c.apps.local', previewHost: 'shop-1a2b3c-preview.apps.local',
  startedAt: '2026-10-09T11:00:00Z', updatedAt: '2026-10-09T11:00:00Z', toldAt: '2026-10-09T11:00:00Z', ...over,
});

const losing = release({
  id: 'losing', state: 'preview',
  changes: { checkedAt: 'then', tables: [], columns: [{ table: 'shop_order', column: 'note', filled: 3 }], retyped: [], items: [], losing: true, lost: [] },
});

const worlds: Record<string, () => { releases: OdooRelease[]; project?: Partial<ProjectMetadata>; waiting?: boolean }> = {
  live: () => ({ releases: [
    release({ id: 'r0', state: 'superseded', commit: before, image: 'reg/shop:one', replacedBy: 'r1', startedAt: '2026-10-08T11:00:00Z' }),
    release({ id: 'r1', state: 'live', liveAt: '2026-10-09T12:00:00Z' }),
  ] }),
  preview: () => ({ waiting: true, releases: [release({ id: 'r0', state: 'live', commit: before, image: 'reg/shop:one', startedAt: '2026-10-08T11:00:00Z' }), release({ id: 'r1', state: 'preview' }), losing] }),
  discarded: () => ({ releases: [release({ id: 'r1', state: 'discarded' })] }),
  same: () => ({ project: { clientImport: { state: 'awaited', mode: 'copy', bytes: 0, at: 'then' } }, releases: [release({ id: 'r1', state: 'discarded' })] }),
};

function harness(state: keyof typeof worlds) {
  let service: OdooReleaseService | undefined;
  const vault = new Map<string, string>([['p1/ODOO_ADMIN_PASSWORD', 'kept-in-the-vault']]);
  const mounted = (async () => {
    const h = await mountRouter({
      prefix: '/api/projects',
      router: (db) => {
        const clusters = new ClusterService(db, testClusterAccess(db, { dataKey: KEY }));
        const projectRepos = new ProjectRepoService(db, giteaService, KEY);
        const secrets = projectSecretsFor({
          db: db.projects,
          backend: {
            hasSecret: async (projectId, key) => vault.has(`${projectId}/${key}`),
            getSecret: async (projectId, key) => vault.get(`${projectId}/${key}`) ?? null,
            listSecrets: async (projectId) => [...vault.keys()].filter((entry) => entry.startsWith(`${projectId}/`)).map((entry) => ({ key: entry.slice(projectId.length + 1) })),
            setSecret: async (projectId, key, value) => { vault.set(`${projectId}/${key}`, value); return { secretReference: `secret://${projectId}/${key}` }; },
          },
          readToken: async () => { throw new Error('an Odoo release mints no read token'); },
        });
        service = new OdooReleaseService({
          store: db,
          runs: temporal.runs,
          how: async (project) => releaseHowOf(project, await treeTypeOfProject(db.projects, project), true),
          chartAt: async (repoOwner, repo, commit) => (await giteaService.getRawFile(repoOwner, repo, 'deploy/chart/Chart.yaml', commit)) !== null,
          diff: (project, base, head) => projectRepos.diffCommits({ ownerId: project.ownerId!, owner: project.giteaOwner!, repo: project.giteaRepo!, base, head }),
          releaseWhen: async (project) => (await treeTypeOfProject(db.projects, project))?.releaseWhen,
          clusterById: (id) => clusters.getByIdUnscoped(id),
          secrets: {
            ensure: (project, options) => secrets.ensure(project, options),
            keep: (projectId, key, value) => secrets.keep(projectId, key, value),
            chartKeepsOwnSecret: async (repoOwner, repo, commit) => (await giteaService.getRawFile(repoOwner, repo, 'deploy/chart/templates/secret.yaml', commit)) !== null,
            onCluster: async () => undefined,
          },
          now: () => NOW,
          newId: () => 'r2',
        });
        return releasesRouter({ releases: service, getOwnedProject: ownedProject(db), signIns: (project) => secrets.signIns(project, ODOO_RELEASE_SECRETS) });
      },
    });
    const { db } = h;
    await db.projects.saveGiteaAccount(account);
    await db.infrastructure.saveCluster({ id: 'c1', name: 'dev', provider: 'machine', machineId: 'dev', status: 'healthy', ownerId: TEST_USER.id } as ClusterMetadata);
    const project: ProjectMetadata = { id: 'p1', name: 'Shop', ownerId: TEST_USER.id, appType: 'gitapp', giteaOwner: owner, giteaRepo: 'shop', targetClusterId: 'c1', releaseName: 'shop-1a2b3c', requiredSecrets: [{ key: 'ODOO_ADMIN_PASSWORD', source: 'generated' }], createdAt: 'then' };
    const world = worlds[state]!();
    await db.projects.saveProject({ ...project, ...world.project });
    await db.projects.saveProject({ id: 'p2', name: 'Theirs', ownerId: 'someone-else', appType: 'gitapp', targetClusterId: 'c1', createdAt: 'then' });
    await db.infrastructure.saveDeploymentInfo({ id: 'odoo-p1', name: 'Shop', clusterId: 'c1', strategy: 'helm', appType: 'odoo-project', namespace: 'shop-1a2b3c', ownerId: TEST_USER.id, gitappProjectId: 'p1', status: 'running', localExposureUrl: 'http://shop.localhost:8000', previewLocalUrl: 'http://shop-preview.localhost:8000', createdAt: 'then' });
    await db.releases.savePipelineRunInfo({ id: 'b1', projectId: 'p1', commitSha: after, imageTag: 'reg/shop:two', status: 'succeeded', startedAt: 'then' } as PipelineRunMetadata);
    for (const entry of world.releases) await db.releases.saveOdooRelease(entry);
    temporal.started.length = 0;
    if (world.waiting) await temporal.runs.start({ projectId: 'p1', ownerId: TEST_USER.id, agent: 'release', inputs: {} as never });
    return {
      url: h.url,
      close: async () => {
        await service?.stop();
        await temporal.end('p1');
        await h.close();
      },
    } satisfies Pick<Harness, 'url' | 'close'>;
  })();
  return { mounted };
}

describe('a project\'s releases', () => {
  it('lists the releases of a project the person owns, and nothing of one they do not', async () => {
    const { mounted } = harness('live');
    const h = await mounted;
    expect((await axios.get(h.url('/api/projects/p1/releases'))).data).toEqual({
      releases: worlds.live!().releases.slice().reverse(),
      addresses: { live: 'http://shop.localhost:8000', preview: 'http://shop-preview.localhost:8000' },
      rollBack: { from: 'r1', to: 'r0', commit: before, liveSince: '2026-10-09T12:00:00Z' },
    });
    expect((await axios.get(h.url('/api/projects/p2/releases'), quiet)).status).toBe(404);
    await h.close();
  });

  it('shows the sign-in its vault holds, uncached, and nothing of a project the person does not own', async () => {
    const h = await harness('live').mounted;
    const shown = await axios.get(h.url('/api/projects/p1/sign-in'));
    expect(shown.data).toEqual({ signIns: [{ login: 'admin', password: 'kept-in-the-vault', describe: 'The password of Odoo\'s admin user, set on every release.' }] });
    expect(shown.headers['cache-control']).toBe('no-store');
    expect((await axios.get(h.url('/api/projects/p2/sign-in'), { validateStatus: () => true })).status).toBe(404);
    await h.close();
  });

  it('cuts a preview over or discards it, and says why when it cannot', async () => {
    const h = await harness('preview').mounted;
    expect((await axios.post(h.url('/api/projects/p1/releases/r1/cut-over'), {}, quiet)).status).toBe(202);
    expect((await axios.post(h.url('/api/projects/p1/releases/r1/discard'), {}, quiet)).status).toBe(202);
    expect((await axios.post(h.url('/api/projects/p1/releases/r1/retest'), {}, quiet)).status).toBe(202);
    expect(await temporal.answers('p1')).toEqual(['decide: Cut over', 'decide: Discard', 'decide: Run tests again']);
    const lost = 'the column shop_order.note is dropped; 3 rows held a value in it';
    expect((await axios.post(h.url('/api/projects/p1/releases/losing/cut-over'), {}, quiet)).data).toEqual({ error: `cutting this release over would lose: ${lost}. Confirm the loss to cut over anyway`, losing: [lost] });
    expect((await axios.post(h.url('/api/projects/p1/releases/losing/cut-over'), { confirm: true }, quiet)).status).toBe(202);
    expect((await temporal.answers('p1')).at(-1)).toBe('decideLosing: Cut over, losing what is listed');
    expect((await axios.post(h.url('/api/projects/p2/releases/r1/retest'), {}, quiet)).status).toBe(404);
    expect((await axios.post(h.url('/api/projects/p2/releases/r1/cut-over'), {}, quiet)).status).toBe(404);
    await h.close();

    const h2 = await harness('live').mounted;
    expect((await axios.post(h2.url('/api/projects/p1/releases/r1/cut-over'), {}, quiet)).data).toEqual({ error: 'the release is live, so it cannot be cut over' });
    expect((await axios.post(h2.url('/api/projects/p1/releases/r1/retest'), {}, quiet)).data).toEqual({ error: 'the release is live, so it cannot be tested again' });
    await h2.close();
  });

  it('rolls a live release back, and says why when it cannot', async () => {
    const h = await harness('live').mounted;
    expect((await axios.post(h.url('/api/projects/p1/releases/r1/roll-back'), {}, quiet)).status).toBe(202);
    expect(temporal.started.map((run) => [run.agent, run.projectId, run.inputs.from])).toEqual([['release-roll-back', 'p1', 'r1']]);
    expect((await axios.post(h.url('/api/projects/p2/releases/r1/roll-back'), {}, quiet)).status).toBe(404);
    await h.close();

    const h2 = await harness('preview').mounted;
    const refused = await axios.post(h2.url('/api/projects/p1/releases/r1/roll-back'), {}, quiet);
    expect([refused.status, refused.data]).toEqual([409, { error: 'the release is preview, not live' }]);
    expect((await axios.get(h2.url('/api/projects/p1/releases'))).data).not.toHaveProperty('rollBack');
    await h2.close();
  });

  it('releases a build again, and says why when it cannot', async () => {
    const h = await harness('discarded').mounted;
    const again = await axios.post(h.url('/api/projects/p1/releases/r1/again'), {}, quiet);
    expect([again.status, again.data]).toEqual([202, { release: {
      id: 'r2', ownerId: TEST_USER.id, projectId: 'p1', pipelineRunId: 'b1', commit: after, image: 'reg/shop:two', state: 'preparing', again: 'r1',
      host: 'shop-1a2b3c.apps.local', previewHost: 'shop-1a2b3c-preview.apps.local', startedAt: NOW, updatedAt: NOW, toldAt: NOW,
    } }]);
    expect(temporal.started.map((run) => [run.agent, run.projectId, (run.inputs.build as { releaseId: string }).releaseId])).toEqual([['release', 'p1', 'r2']]);
    expect((await axios.post(h.url('/api/projects/p2/releases/r1/again'), {}, quiet)).status).toBe(404);
    await h.close();
    const live = await harness('live').mounted;
    expect((await axios.post(live.url('/api/projects/p1/releases/r1/again'), {}, quiet)).data).toEqual({ error: 'the release is live, so its build cannot be released again' });
    await live.close();
    const held = await harness('same').mounted;
    expect((await axios.post(held.url('/api/projects/p1/releases/r1/again'), {}, quiet)).data).toEqual({ error: HELD_FOR_CLIENT });
    await held.close();
  });

  it('lists the files a release changes, and nothing of a release it does not have', async () => {
    const h = await harness('preview').mounted;
    expect((await axios.get(h.url('/api/projects/p1/releases/r1/files'))).data).toMatchObject({ against: { releaseId: 'r0' }, files: [{ path: 'addons/x.py', inApp: true }] });
    expect((await axios.get(h.url('/api/projects/p1/releases/zz/files'), quiet)).status).toBe(404);
    expect((await axios.get(h.url('/api/projects/p2/releases/r1/files'), quiet)).status).toBe(404);
    await h.close();
  });
});
