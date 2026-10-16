import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { OdooReleaseService, type ReleaseRuns } from './OdooReleaseService.js';
import { newReleaseName } from '../lib/odoo-release.js';
import { marked, type ReleaseMark, type ReleaseRunInput, type RollBackRunInput } from '../lib/release-run.js';
import type { ClusterMetadata, PipelineRunMetadata, ProjectMetadata } from '../lib/types.js';

let db: MemoryDB;
let running: boolean;
let started: { projectId: string; ownerId: string; agent: string; inputs: ReleaseRunInput | RollBackRunInput }[];
let answered: string[];
let stopped: string[];

const runs: ReleaseRuns = {
  start: async (request) => { started.push(request); running = true; },
  running: async () => running,
  answer: async (projectId, choice, nodeId) => { answered.push(`${projectId}: ${choice}${nodeId && nodeId !== 'decide' ? ` (${nodeId})` : ''}`); },
  stop: async (projectId) => { stopped.push(projectId); },
};

let ids = 0;
let ticks = 0;
const now = () => new Date(Date.parse('2026-10-08T12:00:00Z') + (ticks += 1) * 1000).toISOString();
const service = () => new OdooReleaseService({ store: db as never, runs, chartAt: async (_o, _r, commit) => commit !== 'no-chart', now, newId: () => `r${(ids += 1)}`, pollMs: 5 });

const project = { id: 'p1', name: 'Shop', ownerId: 'bo', giteaOwner: 'bo', giteaRepo: 'shop', targetClusterId: 'c1' } as ProjectMetadata;
const run = (id: string, commit: string) => ({ id, projectId: 'p1', commitSha: commit, imageTag: `reg/bo/shop:${commit}`, status: 'succeeded' }) as PipelineRunMetadata;

const engineMarks = async (releaseId: string, mark: ReleaseMark) => {
  for (const change of marked(await db.getOdooReleases('bo', 'p1'), releaseId, mark, now())) await db.saveOdooRelease(change);
};
const runEnds = async (svc: OdooReleaseService) => {
  running = false;
  await svc.follow('bo', 'p1');
};
const nextStarts = async (svc: OdooReleaseService, count: number) => {
  running = false;
  const following = svc.follow('bo', 'p1');
  for (let tries = 0; tries < 200 && started.length < count; tries += 1) await new Promise((done) => setTimeout(done, 5));
  running = false;
  await following;
};
const stateOf = async (id: string) => (await db.getOdooReleases('bo', 'p1')).find((entry) => entry.id === id);

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
  await db.saveClusterInfo({ id: 'c1', name: 'dev', provider: 'k3d', status: 'healthy', ownerId: 'bo' } as ClusterMetadata);
  await db.saveProject({ ...project, appType: 'gitapp', createdAt: 't' });
  running = false;
  started = [];
  answered = [];
  stopped = [];
  ids = 0;
  ticks = 0;
});

describe('releasing a project\'s build', () => {
  it('releases by chart only a commit whose repository has one', async () => {
    expect(await service().releasesByChart(project, 'abc')).toBe(true);
    expect(await service().releasesByChart(project, 'no-chart')).toBe(false);
    expect(await service().releasesByChart({ giteaOwner: undefined, giteaRepo: undefined } as never, 'abc')).toBe(false);
  });

  it('records the release, gives the project a deployment, and starts the release agent on it as the project\'s owner', async () => {
    const name = newReleaseName(project);
    const release = await service().release(project, run('b1', 'abc'));
    expect(release).toMatchObject({ id: 'r1', state: 'preparing', host: `${name}.apps.local`, previewHost: `${name}-preview.apps.local`, image: 'reg/bo/shop:abc' });
    expect(started).toEqual([{
      projectId: 'p1', ownerId: 'bo', agent: 'release',
      inputs: {
        ownerId: 'bo', projectId: 'p1', adapter: 'odoo',
        target: { clusterName: 'dev', provider: 'k3d', namespace: name, release: name, owner: { ownerId: 'bo', projectId: 'p1' } },
        host: `${name}.apps.local`, previewHost: `${name}-preview.apps.local`,
        secretTarget: { clusterName: 'dev', provider: 'k3d', isMock: false },
        build: { releaseId: 'r1', image: 'reg/bo/shop:abc', source: { owner: 'bo', repo: 'shop', commit: 'abc' } },
      },
    }]);
    expect((await db.getDeployments())[0]).toMatchObject({ name: 'Shop', appType: 'odoo-project', namespace: name, gitappProjectId: 'p1', status: 'deploying', ownerId: 'bo', clusterId: 'c1' });
    expect((await db.getProjects()).find((entry) => entry.id === 'p1')?.releaseName).toBe(name);
  });

  it('keeps the name a project\'s releases already have, whether it was stored or came before names were stored', async () => {
    const svc = service();
    await svc.release(project, run('b1', 'abc'));
    const first = (await db.getDeployments())[0]!.namespace;
    await runEnds(svc);
    await svc.release(project, run('b2', 'def'));
    expect(started.map((entry) => entry.inputs.target.namespace)).toEqual([first, first]);

    await db.saveOdooRelease({ id: 'old', ownerId: 'bo', projectId: 'p9', pipelineRunId: 'x', commit: 'c', image: 'i:t', state: 'live', host: 'h', startedAt: 't', updatedAt: 't' });
    running = false;
    await svc.release({ ...project, id: 'p9', name: 'Old Shop' }, run('b3', 'aaa'));
    expect(started.at(-1)!.inputs.target.namespace).toBe('old-shop');
  });

  it('hands a new project\'s release its vault: the database and admin passwords the chart and jobs read from it', async () => {
    const ensured: string[] = [];
    const svc = new OdooReleaseService({
      store: db as never, runs, chartAt: async () => true, newId: () => 'r1', pollMs: 5,
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
    expect((started[0]!.inputs as ReleaseRunInput).build.vault).toEqual({
      projectId: 'p1', secret: `${name}-vault`, keys: ['POSTGRES_PASSWORD', 'ODOO_ADMIN_PASSWORD'], database: { secret: `${name}-vault`, key: 'POSTGRES_PASSWORD' }, adminKey: 'ODOO_ADMIN_PASSWORD',
    });
  });

  it('carries the database password of a chart that keeps its own into the vault, and keeps reading it where the chart does', async () => {
    const kept: string[] = [];
    let seeded: string | undefined;
    await db.saveOdooRelease({ id: 'old', ownerId: 'bo', projectId: 'p1', pipelineRunId: 'x', commit: 'c', image: 'i:t', state: 'live', host: 'h', startedAt: 't', updatedAt: 't' });
    const svc = new OdooReleaseService({
      store: db as never, runs, chartAt: async () => true, newId: () => 'r1', pollMs: 5,
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
    expect((started[0]!.inputs as ReleaseRunInput).build.vault?.database).toEqual({ secret: 'shop-secrets', key: 'postgres-password' });
  });

  it('does not release while a secret the type needs waits for the person, and says which', async () => {
    const svc = new OdooReleaseService({
      store: db as never, runs, chartAt: async () => true, newId: () => 'r1', pollMs: 5,
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
      store: db as never, runs, chartAt: async () => true, newId: () => `r${(ids += 1)}`, pollMs: 5,
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
});

describe('one release at a time per project', () => {
  it('queues a build that arrives while one is being prepared, and starts the newest waiting one when that ends, setting older ones aside', async () => {
    const svc = service();
    await svc.release(project, run('b1', 'aaa'));
    expect(await svc.release(project, run('b2', 'bbb'))).toMatchObject({ id: 'r2', state: 'queued' });
    await svc.release(project, run('b3', 'ccc'));
    expect(stopped).toEqual([]);
    expect(started).toHaveLength(1);

    await engineMarks('r1', { state: 'live', slot: 'a' });
    await nextStarts(svc, 2);
    expect(started.map((entry) => (entry.inputs as ReleaseRunInput).build.releaseId)).toEqual(['r1', 'r3']);
    expect(await stateOf('r2')).toMatchObject({ state: 'superseded', reason: 'a newer build took its place' });
    expect(await stateOf('r3')).toMatchObject({ state: 'failed', reason: 'the release stopped before it said how it went' });
  });

  it('stops a release whose preview waits for the person when a newer build arrives, and releases the newer one next', async () => {
    const svc = service();
    await svc.release(project, run('b1', 'aaa'));
    await engineMarks('r1', { state: 'preview', slot: 'b' });
    expect(await svc.release(project, run('b2', 'bbb'))).toMatchObject({ state: 'queued' });
    expect(stopped).toEqual(['p1']);
    await engineMarks('r1', { state: 'superseded', reason: 'a newer build took its place' });
    await nextStarts(svc, 2);
    expect(started.map((entry) => (entry.inputs as ReleaseRunInput).build.releaseId)).toEqual(['r1', 'r2']);
  });

  it('marks a release failed when its run ends without saying how it went', async () => {
    const svc = service();
    await svc.release(project, run('b1', 'abc'));
    await runEnds(svc);
    expect(await stateOf('r1')).toMatchObject({ state: 'failed', reason: 'the release stopped before it said how it went' });
  });
});

describe('a project that starts from a client\'s database', () => {
  const uploaded = { state: 'uploaded', mode: 'copy', bytes: 10, version: '20.0', modules: ['base', 'sale'], at: 't' };
  const importOf = async () => (await db.getProjects()).find((entry) => entry.id === 'p1')?.clientImport;

  it('restores it in the first release, and records it imported once that release is live', async () => {
    const svc = service();
    await svc.release({ ...project, clientImport: uploaded } as ProjectMetadata, run('b1', 'abc'));
    expect((started[0]!.inputs as ReleaseRunInput).build.restore).toEqual({ mode: 'copy' });
    expect(await stateOf('r1')).toMatchObject({ restore: { mode: 'copy', version: '20.0', modules: 2 } });
    expect(await importOf()).toMatchObject({ state: 'importing', releaseId: 'r1' });
    await engineMarks('r1', { state: 'live', slot: 'a' } as ReleaseMark);
    await runEnds(svc);
    expect(await importOf()).toMatchObject({ state: 'imported', releaseId: 'r1' });
  });

  it('records it refused with the modules the restore found missing, and restores it again with the next build', async () => {
    const svc = service();
    await svc.release({ ...project, clientImport: uploaded } as ProjectMetadata, run('b1', 'abc'));
    await engineMarks('r1', { state: 'failed', reason: 'shop-restore-a failed:\nERROR missing modules: web_studio' } as ReleaseMark);
    await runEnds(svc);
    expect(await importOf()).toMatchObject({ state: 'refused', missing: ['web_studio'], reason: expect.stringContaining('this project does not: web_studio') });
    const stored = (await db.getProjects()).find((entry) => entry.id === 'p1')!;
    await svc.release(stored, run('b2', 'def'));
    expect((started.at(-1)!.inputs as ReleaseRunInput).build.restore).toEqual({ mode: 'copy' });
  });

  it('records it refused when the build\'s Odoo is another version than the backup\'s', async () => {
    const svc = service();
    await svc.release({ ...project, clientImport: uploaded } as ProjectMetadata, run('b1', 'abc'));
    await engineMarks('r1', { state: 'failed', reason: 'shop-restore-a failed:\nERROR wrong version: the backup is from Odoo 20.0, and this project\'s image runs Odoo 18.0' } as ReleaseMark);
    await runEnds(svc);
    expect(await importOf()).toMatchObject({ state: 'refused', reason: 'the backup is from Odoo 20.0, and this project\'s image runs Odoo 18.0' });
  });

  it('holds the first release while the client\'s database is awaited, saying so on the build and to the channel', async () => {
    const waited: string[] = [];
    const svc = new OdooReleaseService({ store: db as never, runs, chartAt: async () => true, now, newId: () => `r${(ids += 1)}`, pollMs: 5, awaiting: (_owner, entry, built) => { waited.push(`${entry.id} ${built.commitSha}`); } });
    await db.savePipelineRunInfo({ ...run('b1', 'abc'), startedAt: 't' } as never);
    expect(await svc.release({ ...project, clientImport: { state: 'awaited', mode: 'copy', bytes: 0, at: 't' } } as ProjectMetadata, run('b1', 'abc'))).toEqual({ skipped: 'waiting for the client\'s database: upload their backup on the project\'s Settings, or start without it there' });
    expect(started).toEqual([]);
    expect(waited).toEqual(['p1 abc']);
    expect((await db.getPipelineRuns()).find((entry) => entry.id === 'b1')?.releaseHeld).toContain('waiting for the client\'s database');
  });

  it('never restores over a project that has released', async () => {
    const svc = service();
    await svc.release(project, run('b1', 'abc'));
    await engineMarks('r1', { state: 'live', slot: 'a' } as ReleaseMark);
    await runEnds(svc);
    await svc.release({ ...project, clientImport: uploaded } as ProjectMetadata, run('b2', 'def'));
    expect((started.at(-1)!.inputs as ReleaseRunInput).build.restore).toBeUndefined();
  });
});

describe('the person\'s decisions', () => {
  it('cuts over a release that would lose something only when the person confirms the loss, answering the losing choice', async () => {
    const svc = service();
    await svc.release(project, run('b1', 'abc'));
    const changes = { checkedAt: 't', tables: [], columns: [{ table: 'shop_order', column: 'note', filled: 3 }], retyped: [], items: [{ kind: 'edited-view', key: 'id:7', name: 'The view Order form, edited in the app,', state: 'reset' as const }], losing: true, lost: [] };
    await engineMarks('r1', { state: 'preview', slot: 'b', changes, e2e: { state: 'passed', summary: '1 passed', startedAt: 't0', finishedAt: 't1' } });
    expect(await svc.decide('bo', 'r1', 'cutOver')).toEqual({
      status: 409,
      error: 'cutting this release over would lose: the column shop_order.note is dropped; 3 rows held a value in it; The view Order form, edited in the app, is reset. Confirm the loss to cut over anyway',
      losing: ['the column shop_order.note is dropped; 3 rows held a value in it', 'The view Order form, edited in the app, is reset'],
    });
    expect(answered).toEqual([]);
    expect(await svc.retest('bo', 'r1')).toMatchObject({ id: 'r1' });
    expect(await svc.decide('bo', 'r1', 'cutOver', true)).toMatchObject({ id: 'r1' });
    expect(await svc.decide('bo', 'r1', 'discard')).toMatchObject({ id: 'r1' });
    expect(answered).toEqual(['p1: Run tests again (decideLosing)', 'p1: Cut over, losing what is listed (decideLosing)', 'p1: Discard (decideLosing)']);
  });

  it('answers the run with the person\'s decision on a preview whose tests have run, and refuses one that is not waiting', async () => {
    const svc = service();
    await svc.release(project, run('b1', 'abc'));
    await engineMarks('r1', { state: 'preview', slot: 'b', e2e: { state: 'running', startedAt: 't0' } });
    expect(await svc.decide('bo', 'r1', 'cutOver')).toEqual({ status: 409, error: 'its browser tests are still running, so it cannot be cut over yet' });
    await engineMarks('r1', { state: 'preview', e2e: { state: 'passed', summary: '1 passed', startedAt: 't0', finishedAt: 't1' } });
    expect(await svc.retest('bo', 'r1')).toMatchObject({ id: 'r1' });
    expect(await svc.decide('bo', 'r1', 'cutOver')).toMatchObject({ id: 'r1' });
    expect(await svc.decide('bo', 'r1', 'discard')).toMatchObject({ id: 'r1' });
    expect(answered).toEqual(['p1: Run tests again', 'p1: Cut over', 'p1: Discard']);
    running = false;
    expect(await svc.decide('bo', 'r1', 'cutOver')).toEqual({ status: 409, error: 'no release is waiting for this preview, so it cannot be cut over: push again to release it' });
    running = true;
    expect(await svc.decide('cy', 'r1', 'discard')).toEqual({ status: 404, error: 'You have no release with that id' });
    await engineMarks('r1', { state: 'live' });
    expect(await svc.retest('bo', 'r1')).toEqual({ status: 409, error: 'the release is live, so it cannot be tested again' });
  });
});

describe('what the run records', () => {
  it('tells the person each change, and marks the deployment running with the live image', async () => {
    const seen: string[] = [];
    const svc = new OdooReleaseService({ store: db as never, runs, chartAt: async () => true, now, newId: () => `r${(ids += 1)}`, pollMs: 5, notify: (_owner, release) => seen.push(`${release.id} ${release.state}`) });
    await svc.release(project, run('b1', 'aaa'));
    await engineMarks('r1', { state: 'live', slot: 'a' });
    await runEnds(svc);
    expect(seen).toEqual(['r1 live']);
    expect((await db.getDeployments())[0]).toMatchObject({ status: 'running', gitappImageTag: 'reg/bo/shop:aaa' });
  });
});

describe('rolling back', () => {
  const twoReleases = async (svc: OdooReleaseService) => {
    await svc.release(project, run('b1', 'aaaaaaaaaa'));
    await engineMarks('r1', { state: 'live', slot: 'a' });
    await runEnds(svc);
    await svc.release(project, run('b2', 'bbbbbbbbbb'));
    await engineMarks('r2', { state: 'live', slot: 'b' });
    await runEnds(svc);
  };

  it('offers to go back to the release a cutover replaced, and starts the roll back agent with both releases', async () => {
    const svc = service();
    await twoReleases(svc);
    const live = (await stateOf('r2'))!;
    expect(await svc.rollBackOffer('bo', 'p1')).toEqual({ from: 'r2', to: 'r1', commit: 'aaaaaaaaaa', liveSince: live.liveAt });
    expect(await svc.rollBack('bo', project, 'r1')).toEqual({ status: 409, error: 'the release is superseded, not live' });
    expect(await svc.rollBack('bo', project, 'r2')).toMatchObject({ id: 'r2' });
    expect(started.at(-1)).toMatchObject({ agent: 'release-roll-back', inputs: { from: 'r2', to: { releaseId: 'r1', image: 'reg/bo/shop:aaaaaaaaaa', source: { owner: 'bo', repo: 'shop', commit: 'aaaaaaaaaa' } } } });
  });

  it('will not roll back once a later build has taken the kept slot, nor twice at once', async () => {
    const svc = service();
    await twoReleases(svc);
    expect(await svc.rollBack('bo', project, 'r2')).toMatchObject({ id: 'r2' });
    expect(await svc.rollBack('bo', project, 'r2')).toEqual({ status: 409, error: 'a release is in progress: wait for it to finish' });
    running = false;
    await svc.release(project, run('b3', 'cccccccccc'));
    await engineMarks('r3', { state: 'preview', slot: 'a' });
    expect(await svc.rollBack('bo', project, 'r2')).toEqual({ status: 409, error: 'the build of cccccccc has taken the slot the earlier release was kept in' });
  });
});

describe('where the app answers', () => {
  it('gives the addresses the project\'s app and preview are exposed on, and none before they are', async () => {
    const svc = service();
    await svc.release(project, run('b1', 'abc'));
    expect(await svc.addresses('p1')).toEqual({});
    const deployment = (await db.getDeployments())[0]!;
    await db.saveDeploymentInfo({ id: deployment.id, localExposureUrl: 'http://shop.localhost:8000', previewLocalUrl: 'http://shop-preview.localhost:8000', publicExposureUrl: 'https://shop-x.dev' });
    expect(await svc.addresses('p1')).toEqual({ live: 'https://shop-x.dev', preview: 'http://shop-preview.localhost:8000' });
  });
});
