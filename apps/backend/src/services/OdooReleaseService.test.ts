import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { OdooReleaseService, type ReleaseWorkflows } from './OdooReleaseService.js';
import { newReleaseName } from '../lib/odoo-release.js';
import type { ReleaseProgress } from '../workflows/OdooReleaseWorkflow.js';
import type { ClusterMetadata, PipelineRunMetadata, ProjectMetadata } from '../lib/types.js';

let db: MemoryDB;
let progress: Record<string, ReleaseProgress>;
let running: boolean;
let started: { workflowId: string; input: unknown; build: { releaseId: string; image: string }; owner: string }[];
let decided: string[];
let rolled: { workflowId: string; rollBack: unknown; owner: string }[];

const workflows: ReleaseWorkflows = {
  release: async (workflowId, input, build, owner) => { started.push({ workflowId, input, build, owner }); },
  progress: async () => progress,
  final: async () => progress,
  running: async () => running,
  decide: async (_workflowId, releaseId, decision) => { decided.push(`${decision} ${releaseId}`); },
  retest: async (_workflowId, releaseId) => { decided.push(`retest ${releaseId}`); },
  rollBack: async (workflowId, _input, rollBack, owner) => { rolled.push({ workflowId, rollBack, owner }); },
};

let ids = 0;
let ticks = 0;
const service = () => new OdooReleaseService({ store: db as never, workflows, chartAt: async (_o, _r, commit) => commit !== 'no-chart', now: () => new Date(Date.parse('2026-10-08T12:00:00Z') + (ticks += 1) * 1000).toISOString(), newId: () => `r${(ids += 1)}`, pollMs: 5 });

const project = { id: 'p1', name: 'Shop', ownerId: 'bo', giteaOwner: 'bo', giteaRepo: 'shop', targetClusterId: 'c1' } as ProjectMetadata;
const run = (id: string, commit: string) => ({ id, projectId: 'p1', commitSha: commit, imageTag: `reg/bo/shop:${commit}`, status: 'succeeded' }) as PipelineRunMetadata;

const settled = async (svc: OdooReleaseService) => {
  await svc.follow('bo', 'p1');
  await svc.follow('bo', 'p1');
};

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
  await db.saveClusterInfo({ id: 'c1', name: 'dev', provider: 'k3d', status: 'healthy', ownerId: 'bo' } as ClusterMetadata);
  await db.saveProject({ ...project, appType: 'gitapp', createdAt: 't' });
  progress = {};
  running = false;
  started = [];
  decided = [];
  rolled = [];
  ids = 0;
  ticks = 0;
});

describe('releasing an Odoo project\'s build', () => {
  it('releases by chart only a commit whose repository has one', async () => {
    expect(await service().releasesByChart(project, 'abc')).toBe(true);
    expect(await service().releasesByChart(project, 'no-chart')).toBe(false);
    expect(await service().releasesByChart({ giteaOwner: undefined, giteaRepo: undefined } as never, 'abc')).toBe(false);
  });

  it('records the release, gives the project a deployment, and hands the build to the project\'s release workflow as its owner', async () => {
    const name = newReleaseName(project);
    const release = await service().release(project, run('b1', 'abc'));
    expect(release).toMatchObject({ id: 'r1', state: 'preparing', host: `${name}.apps.local`, previewHost: `${name}-preview.apps.local`, image: 'reg/bo/shop:abc' });
    expect(started).toEqual([{ workflowId: 'odoo-release-p1', owner: 'bo', input: { target: { clusterName: 'dev', provider: 'k3d', namespace: name, release: name, owner: { ownerId: 'bo', projectId: 'p1' } }, host: `${name}.apps.local`, previewHost: `${name}-preview.apps.local`, ownerId: 'bo', e2eMinutes: 20 }, build: { releaseId: 'r1', image: 'reg/bo/shop:abc', source: { owner: 'bo', repo: 'shop', commit: 'abc' } } }]);
    expect((await db.getDeployments())[0]).toMatchObject({ name: 'Shop', appType: 'odoo-project', namespace: name, gitappProjectId: 'p1', status: 'deploying', ownerId: 'bo', clusterId: 'c1' });
    expect((await db.getProjects()).find((entry) => entry.id === 'p1')?.releaseName).toBe(name);
  });

  it('keeps the name a project\'s releases already have, whether it was stored or came before names were stored', async () => {
    const svc = service();
    await svc.release(project, run('b1', 'abc'));
    const first = (await db.getDeployments())[0]!.namespace;
    await svc.release(project, run('b2', 'def'));
    expect(started.map((entry) => (entry as { input: { target: { namespace: string } } }).input.target.namespace)).toEqual([first, first]);

    await db.saveOdooRelease({ id: 'old', ownerId: 'bo', projectId: 'p9', pipelineRunId: 'x', commit: 'c', image: 'i:t', state: 'live', host: 'h', startedAt: 't', updatedAt: 't' });
    await svc.release({ ...project, id: 'p9', name: 'Old Shop' }, run('b3', 'aaa'));
    expect((started.at(-1) as { input: { target: { namespace: string } } }).input.target.namespace).toBe('old-shop');
  });

  it('hands a new project\'s release its vault: the database and admin passwords the chart and jobs read from it', async () => {
    const ensured: string[] = [];
    const svc = new OdooReleaseService({
      store: db as never, workflows, chartAt: async () => true, newId: () => 'r1', pollMs: 5,
      secrets: {
        ensure: async (entry) => { ensured.push(entry.id); return { declared: [{ key: 'POSTGRES_PASSWORD', source: 'generated', describe: 'd' }, { key: 'ODOO_ADMIN_PASSWORD', source: 'generated', describe: 'a', signInAs: 'admin' }], waiting: [] }; },
        keep: async () => { throw new Error('nothing to carry over'); },
        chartKeepsOwnSecret: async () => false,
        onCluster: async () => undefined,
      },
    });
    await svc.release(project, run('b1', 'abc'));
    const name = newReleaseName(project);
    expect(ensured).toEqual(['p1']);
    expect((started[0]!.build as { vault?: unknown }).vault).toEqual({
      projectId: 'p1', secret: `${name}-vault`, keys: ['POSTGRES_PASSWORD', 'ODOO_ADMIN_PASSWORD'], database: { secret: `${name}-vault`, key: 'POSTGRES_PASSWORD' }, adminKey: 'ODOO_ADMIN_PASSWORD',
    });
  });

  it('carries the database password of a chart that keeps its own into the vault, and keeps reading it where the chart does', async () => {
    const kept: string[] = [];
    let seeded: string | undefined;
    await db.saveOdooRelease({ id: 'old', ownerId: 'bo', projectId: 'p1', pipelineRunId: 'x', commit: 'c', image: 'i:t', state: 'live', host: 'h', startedAt: 't', updatedAt: 't' });
    const svc = new OdooReleaseService({
      store: db as never, workflows, chartAt: async () => true, newId: () => 'r1', pollMs: 5,
      secrets: {
        ensure: async (_entry, options) => { seeded = await options.seed?.('POSTGRES_PASSWORD'); return { declared: [{ key: 'POSTGRES_PASSWORD', source: 'generated', describe: 'd' }], waiting: [] }; },
        keep: async (projectId, key, value) => { kept.push(`${projectId} ${key}=${value}`); },
        chartKeepsOwnSecret: async () => true,
        onCluster: async (_cluster, namespace, secret, key) => (namespace === 'shop' && secret === 'shop-secrets' && key === 'postgres-password' ? 'running' : undefined),
      },
    });
    await svc.release(project, run('b2', 'def'));
    expect(seeded).toBe('running');
    expect(kept).toEqual(['p1 POSTGRES_PASSWORD=running']);
    expect((started[0]!.build as { vault?: { database: unknown } }).vault?.database).toEqual({ secret: 'shop-secrets', key: 'postgres-password' });
  });

  it('does not release while a secret the type needs waits for the person, and says which', async () => {
    const svc = new OdooReleaseService({
      store: db as never, workflows, chartAt: async () => true, newId: () => 'r1', pollMs: 5,
      secrets: {
        ensure: async () => ({ declared: [{ key: 'STRIPE_KEY', source: 'person', describe: 'd' }], waiting: ['STRIPE_KEY'] }),
        keep: async () => undefined,
        chartKeepsOwnSecret: async () => false,
        onCluster: async () => undefined,
      },
    });
    expect(await svc.release(project, run('b1', 'abc'))).toEqual({ status: 409, error: 'the project\'s secrets could not be put in its vault: waiting for the person to enter STRIPE_KEY' });
    expect(started).toEqual([]);
    expect((await db.getOdooReleases('bo'))[0]).toMatchObject({ state: 'failed', reason: 'the project\'s secrets could not be put in its vault: waiting for the person to enter STRIPE_KEY' });
  });

  it('releases nothing for a build that changed nothing the app is built from, says why on the build, and still releases the first one', async () => {
    const asked: string[] = [];
    const svc = new OdooReleaseService({
      store: db as never, workflows, chartAt: async () => true, newId: () => `r${(ids += 1)}`, pollMs: 5,
      decide: async (_project, since, commit) => { asked.push(`${since}..${commit}`); return commit === 'docs' ? { release: false, reason: 'only PLAN.md changed since abc' } : { release: true }; },
    });
    await db.savePipelineRun(run('b1', 'abc'));
    await db.savePipelineRun(run('b2', 'docs'));
    expect(await svc.release(project, run('b1', 'abc'))).toMatchObject({ state: 'preparing' });
    expect(await svc.release(project, run('b2', 'docs'))).toEqual({ skipped: 'only PLAN.md changed since abc' });
    expect(asked).toEqual(['abc..docs']);
    expect(started).toHaveLength(1);
    expect((await db.getPipelineRuns()).find((entry) => entry.id === 'b2')?.releaseSkipped).toBe('only PLAN.md changed since abc');
  });

  it('refuses a project with no cluster, and a build with no image, and says so on the build', async () => {
    await db.savePipelineRun(run('b1', 'abc'));
    await db.savePipelineRun(run('b2', 'def'));
    expect(await service().release({ ...project, targetClusterId: undefined } as never, run('b1', 'abc'))).toEqual({ status: 409, error: 'the project has no cluster to deploy to' });
    expect(await service().release(project, { ...run('b2', 'def'), imageTag: undefined } as never)).toEqual({ status: 409, error: 'the build has no image to release' });
    expect((await db.getPipelineRuns()).map((entry) => [entry.id, entry.status, entry.releaseRefused])).toEqual([['b1', 'succeeded', 'the project has no cluster to deploy to'], ['b2', 'succeeded', 'the build has no image to release']]);
    expect(await db.getOdooReleases('bo')).toEqual([]);
  });

  it('records what the workflow reports, marks the deployment running once a release is live, and lets only a preview be decided', async () => {
    const svc = service();
    progress = { r1: { state: 'live', slot: 'a' } };
    await svc.release(project, run('b1', 'abc'));
    await settled(svc);
    expect((await svc.list('bo', 'p1'))[0]).toMatchObject({ state: 'live', slot: 'a' });
    expect((await db.getDeployments())[0]!.status).toBe('running');
    expect(await svc.decide('bo', 'r1', 'cutOver')).toEqual({ status: 409, error: 'the release is live, not waiting in preview' });

    const waiting = (await svc.release(project, run('b2', 'def'))) as { id: string };
    await settled(svc);
    await db.saveOdooRelease({ ...(await svc.list('bo', 'p1')).find((entry) => entry.id === waiting.id)!, state: 'preview', slot: 'b' });
    expect(await svc.decide('bo', 'r2', 'cutOver')).toMatchObject({ id: 'r2' });
    expect(decided).toEqual(['cutOver r2']);
    expect(await svc.decide('cy', 'r2', 'discard')).toEqual({ status: 404, error: 'You have no release with that id' });
  });

  it('records the preview\'s browser tests as they run and finish, and runs them again only for a waiting preview', async () => {
    const svc = service();
    progress = { r1: { state: 'preview', slot: 'b', e2e: { state: 'running', startedAt: 't0' } } };
    running = true;
    await svc.release(project, run('b1', 'abc'));
    for (let tries = 0; tries < 100 && (await svc.list('bo', 'p1'))[0]?.e2e?.state !== 'running'; tries += 1) await new Promise((done) => setTimeout(done, 5));
    expect((await svc.list('bo', 'p1'))[0]).toMatchObject({ state: 'preview', e2e: { state: 'running' } });
    progress = { r1: { state: 'preview', slot: 'b', e2e: { state: 'failed', summary: '1 passed, 1 failed', artifacts: [{ id: 'a1', name: 'shot.png' }], startedAt: 't0', finishedAt: 't1' } } };
    for (let tries = 0; tries < 100 && (await svc.list('bo', 'p1'))[0]?.e2e?.state !== 'failed'; tries += 1) await new Promise((done) => setTimeout(done, 5));
    expect((await svc.list('bo', 'p1'))[0]!.e2e).toEqual({ state: 'failed', summary: '1 passed, 1 failed', artifacts: [{ id: 'a1', name: 'shot.png' }], startedAt: 't0', finishedAt: 't1' });
    expect(await svc.retest('bo', 'r1')).toMatchObject({ id: 'r1' });
    expect(await svc.retest('cy', 'r1')).toEqual({ status: 404, error: 'You have no release with that id' });
    running = false;
    progress = { r1: { state: 'live', slot: 'b' } };
    await settled(svc);
    expect(await svc.retest('bo', 'r1')).toEqual({ status: 409, error: 'the release is live, so its browser tests cannot run again' });
    expect(decided).toEqual(['retest r1']);
  });

  it('marks a release failed when its workflow ends without saying how it went', async () => {
    const svc = service();
    await svc.release(project, run('b1', 'abc'));
    progress = {};
    await settled(svc);
    expect((await svc.list('bo', 'p1'))[0]).toMatchObject({ state: 'failed', reason: 'the release stopped being followed before it finished' });
  });

  it('marks the release a cutover replaced as superseded, so only one release is live', async () => {
    const svc = service();
    progress = { r1: { state: 'live', slot: 'a' } };
    await svc.release(project, run('b1', 'aaaaaaaaaa'));
    await settled(svc);
    progress = { r1: { state: 'live', slot: 'a' }, r2: { state: 'live', slot: 'b' } };
    await svc.release(project, run('b2', 'bbbbbbbbbb'));
    await settled(svc);
    await settled(svc);
    const all = await svc.list('bo', 'p1');
    expect(all.filter((entry) => entry.state === 'live').map((entry) => entry.id)).toEqual(['r2']);
    expect(all.find((entry) => entry.id === 'r1')).toMatchObject({ state: 'superseded', reason: 'replaced by the release of bbbbbbbb', replacedBy: 'r2' });
    expect(all.find((entry) => entry.id === 'r2')).toMatchObject({ liveAt: expect.any(String) });
  });

  it('offers to go back to the release a cutover replaced, and hands the rollback to the release workflow', async () => {
    const svc = service();
    progress = { r1: { state: 'live', slot: 'a' } };
    await svc.release(project, run('b1', 'aaaaaaaaaa'));
    await settled(svc);
    expect(await svc.rollBackOffer('bo', 'p1')).toBeUndefined();
    progress = { r1: { state: 'live', slot: 'a' }, r2: { state: 'live', slot: 'b' } };
    await svc.release(project, run('b2', 'bbbbbbbbbb'));
    await settled(svc);
    const live = (await svc.list('bo', 'p1')).find((entry) => entry.id === 'r2')!;
    expect(await svc.rollBackOffer('bo', 'p1')).toEqual({ from: 'r2', to: 'r1', commit: 'aaaaaaaaaa', liveSince: live.liveAt });

    expect(await svc.rollBack('bo', project, 'r1')).toEqual({ status: 409, error: 'the release is superseded, not live' });
    expect(await svc.rollBack('bo', project, 'r2')).toMatchObject({ id: 'r2' });
    expect(rolled).toEqual([{ workflowId: 'odoo-release-p1', owner: 'bo', rollBack: { from: 'r2', to: { releaseId: 'r1', image: 'reg/bo/shop:aaaaaaaaaa', source: { owner: 'bo', repo: 'shop', commit: 'aaaaaaaaaa' } } } }]);
  });

  it('brings the earlier release back to live when the rollback is done, and marks the later one rolled back', async () => {
    const svc = service();
    progress = { r1: { state: 'live', slot: 'a' } };
    await svc.release(project, run('b1', 'aaaaaaaaaa'));
    await settled(svc);
    progress = { r1: { state: 'live', slot: 'a' }, r2: { state: 'live', slot: 'b' } };
    await svc.release(project, run('b2', 'bbbbbbbbbb'));
    await settled(svc);
    await svc.rollBack('bo', project, 'r2');
    progress = { r1: { state: 'live', slot: 'a', restoredAt: '2026-10-08T13:00:00Z' }, r2: { state: 'rolled-back', slot: 'b', reason: 'rolled back to the release of aaaaaaaa' } };
    await settled(svc);
    await settled(svc);
    const all = await svc.list('bo', 'p1');
    expect(all.find((entry) => entry.id === 'r1')).toMatchObject({ state: 'live', slot: 'a', restoredAt: '2026-10-08T13:00:00Z' });
    expect(all.find((entry) => entry.id === 'r1')).not.toHaveProperty('replacedBy');
    expect(all.find((entry) => entry.id === 'r2')).toMatchObject({ state: 'rolled-back', reason: 'rolled back to the release of aaaaaaaa' });
    expect((await db.getDeployments()).find((entry) => entry.gitappProjectId === 'p1')).toMatchObject({ status: 'running', gitappImageTag: 'reg/bo/shop:aaaaaaaaaa' });
    expect(await svc.rollBackOffer('bo', 'p1')).toBeUndefined();
  });

  it('gives the addresses the project\'s app and preview are exposed on, and none before they are', async () => {
    const svc = service();
    await svc.release(project, run('b1', 'abc'));
    expect(await svc.addresses('p1')).toEqual({});
    const deployment = (await db.getDeployments())[0]!;
    await db.saveDeploymentInfo({ id: deployment.id, localExposureUrl: 'http://shop.localhost:8000', previewLocalUrl: 'http://shop-preview.localhost:8000', publicExposureUrl: 'https://shop-x.dev' });
    expect(await svc.addresses('p1')).toEqual({ live: 'https://shop-x.dev', preview: 'http://shop-preview.localhost:8000' });
  });
});
