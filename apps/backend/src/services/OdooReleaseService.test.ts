import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { OdooReleaseService, type ReleaseWorkflows } from './OdooReleaseService.js';
import type { ReleaseProgress } from '../workflows/OdooReleaseWorkflow.js';
import type { ClusterMetadata, PipelineRunMetadata, ProjectMetadata } from '../lib/types.js';

let db: MemoryDB;
let progress: Record<string, ReleaseProgress>;
let running: boolean;
let started: { workflowId: string; input: unknown; build: { releaseId: string; image: string }; owner: string }[];
let decided: string[];

const workflows: ReleaseWorkflows = {
  release: async (workflowId, input, build, owner) => { started.push({ workflowId, input, build, owner }); },
  progress: async () => progress,
  final: async () => progress,
  running: async () => running,
  decide: async (_workflowId, releaseId, decision) => { decided.push(`${decision} ${releaseId}`); },
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
  progress = {};
  running = false;
  started = [];
  decided = [];
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
    const release = await service().release(project, run('b1', 'abc'));
    expect(release).toMatchObject({ id: 'r1', state: 'preparing', host: 'shop.apps.local', previewHost: 'shop-preview.apps.local', image: 'reg/bo/shop:abc' });
    expect(started).toEqual([{ workflowId: 'odoo-release-p1', owner: 'bo', input: { target: { clusterName: 'dev', provider: 'k3d', namespace: 'shop', release: 'shop' }, host: 'shop.apps.local', previewHost: 'shop-preview.apps.local' }, build: { releaseId: 'r1', image: 'reg/bo/shop:abc', source: { owner: 'bo', repo: 'shop', commit: 'abc' } } }]);
    expect((await db.getDeployments())[0]).toMatchObject({ name: 'Shop', appType: 'odoo-project', gitappProjectId: 'p1', status: 'deploying', ownerId: 'bo', clusterId: 'c1' });
  });

  it('refuses a project with no cluster, and a build with no image', async () => {
    expect(await service().release({ ...project, targetClusterId: undefined } as never, run('b1', 'abc'))).toEqual({ status: 409, error: 'the project has no cluster to deploy to' });
    expect(await service().release(project, { ...run('b1', 'abc'), imageTag: undefined } as never)).toEqual({ status: 409, error: 'the build has no image to release' });
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
    expect(all.find((entry) => entry.id === 'r1')).toMatchObject({ state: 'superseded', reason: 'replaced by the release of bbbbbbbb' });
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
