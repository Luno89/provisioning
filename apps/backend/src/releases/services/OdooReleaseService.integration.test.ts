import { containing } from '../../platform/lib/test-matchers.js';
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { OdooReleaseService, type ReleaseRuns } from './OdooReleaseService.js';
import { releaseDecider } from './release-decider.js';
import { noRepositoryRead } from '../testing/no-repository.js';
import { newReleaseName } from '../lib/odoo-release.js';
import { marked, type ReleaseMark, type ReleaseRunInput, type RollBackRunInput } from '../lib/release-run.js';
import type { ClusterMetadata, PipelineRunMetadata, ProjectMetadata } from '../../platform/lib/types.js';

const made: OdooReleaseService[] = [];
type Deps = ConstructorParameters<typeof OdooReleaseService>[0];
class Stopped extends OdooReleaseService {
  constructor(deps: Omit<Deps, 'decide' | 'deploymentChanged'> & Partial<Pick<Deps, 'decide' | 'deploymentChanged'>>) {
    super({ decide: releaseDecider({ trees: db.projects, changed: noRepositoryRead }), deploymentChanged: () => undefined, ...deps });
    made.push(this);
  }
}
afterEach(async () => { await Promise.all(made.splice(0).map((svc) => svc.stop())); });

const fresh = await emptiedEachTime();
let db: MongoDB;
let running: boolean;
let started: { projectId: string; ownerId: string; agent: string; inputs: ReleaseRunInput | RollBackRunInput }[];
let answered: string[];
let stopped: string[];

let closing: (() => void)[] = [];
let starting: { count: number; done: () => void }[] = [];
const endRun = () => {
  running = false;
  for (const done of closing.splice(0)) done();
};
const startsReach = (count: number) => new Promise<void>((done) => {
  if (started.length >= count) done();
  else starting.push({ count, done });
});

let generation = 0;
const runsOfThisTest = (): ReleaseRuns => {
  const mine = generation;
  const current = () => mine === generation;
  return {
    start: async (request) => {
      if (!current()) return;
      started.push(request);
      running = true;
      for (const waiting of starting.filter((entry) => started.length >= entry.count)) waiting.done();
      starting = starting.filter((entry) => started.length < entry.count);
    },
    running: async () => current() && running,
    closed: () => (current() && running ? new Promise<void>((done) => closing.push(done)) : Promise.resolve()),
    answer: async (projectId, choice, nodeId) => { if (current()) answered.push(`${projectId}: ${choice}${nodeId && nodeId !== 'decide' ? ` (${nodeId})` : ''}`); },
    stop: async (projectId) => { if (current()) stopped.push(projectId); },
  };
};
let runs: ReleaseRuns;

let ids = 0;
let ticks = 0;
const now = () => new Date(Date.parse('2026-10-08T12:00:00Z') + (ticks += 1) * 1000).toISOString();
const service = () => new Stopped({ store: db, runs, chartAt: async (_o, _r, commit) => commit !== 'no-chart', now, newId: () => `r${(ids += 1)}` });

const project = { id: 'p1', name: 'Shop', ownerId: 'bo', giteaOwner: 'bo', giteaRepo: 'shop', targetClusterId: 'c1' } as ProjectMetadata;
const run = (id: string, commit: string) => ({ id, projectId: 'p1', commitSha: commit, imageTag: `reg/bo/shop:${commit}`, status: 'succeeded' }) as PipelineRunMetadata;

const engineMarks = async (releaseId: string, mark: ReleaseMark) => {
  for (const change of marked(await db.releases.getOdooReleases('bo', 'p1'), releaseId, mark, now())) await db.releases.saveOdooRelease(change);
};
const runEnds = async (svc: OdooReleaseService) => {
  endRun();
  await svc.follow('bo', 'p1');
};
const nextStarts = async (svc: OdooReleaseService, count: number) => {
  const reached = startsReach(count);
  endRun();
  const following = svc.follow('bo', 'p1');
  await reached;
  endRun();
  await following;
};
const stateOf = async (id: string) => (await db.releases.getOdooReleases('bo', 'p1')).find((entry) => entry.id === id);

beforeEach(async () => {
  generation += 1;
  runs = runsOfThisTest();
  db = await fresh();
  await db.infrastructure.saveCluster({ id: 'c1', name: 'dev', provider: 'machine', machineId: 'dev', status: 'healthy', ownerId: 'bo' } as ClusterMetadata);
  await db.projects.saveProject({ ...project, appType: 'gitapp', createdAt: 't' });
  running = false;
  closing = [];
  starting = [];
  started = [];
  answered = [];
  stopped = [];
  ids = 0;
  ticks = 0;
});

describe('releasing a project\'s build', () => {
  it('stops following its runs when it is stopped, and writes nothing about them afterwards', async () => {
    const svc = service();
    const release = await svc.release(project, run('b1', 'abc'));
    expect(running).toBe(true);
    await svc.stop();
    endRun();
    await new Promise((done) => setImmediate(done));
    expect(await stateOf((release as { id: string }).id)).toMatchObject({ state: 'preparing' });
    expect(await svc.follow('bo', 'p1')).toBeUndefined();
  });

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
        target: { clusterId: 'c1', clusterName: 'dev', provider: 'machine', namespace: name, release: name, owner: { ownerId: 'bo', projectId: 'p1' } },
        host: `${name}.apps.local`, previewHost: `${name}-preview.apps.local`,
        build: { releaseId: 'r1', image: 'reg/bo/shop:abc', source: { owner: 'bo', repo: 'shop', commit: 'abc' } },
      },
    }]);
    expect((await db.infrastructure.getDeployments())[0]).toMatchObject({ name: 'Shop', appType: 'odoo-project', namespace: name, gitappProjectId: 'p1', status: 'deploying', ownerId: 'bo', clusterId: 'c1' });
    expect((await db.projects.getProjects()).find((entry) => entry.id === 'p1')?.releaseName).toBe(name);
  });

  it('keeps the name a project\'s releases already have, whether it was stored or came before names were stored', async () => {
    const svc = service();
    await svc.release(project, run('b1', 'abc'));
    const first = (await db.infrastructure.getDeployments())[0]!.namespace;
    await runEnds(svc);
    await svc.release(project, run('b2', 'def'));
    expect(started.map((entry) => entry.inputs.target.namespace)).toEqual([first, first]);

    await db.releases.saveOdooRelease({ id: 'old', ownerId: 'bo', projectId: 'p9', pipelineRunId: 'x', commit: 'c', image: 'i:t', state: 'live', host: 'h', startedAt: 't', updatedAt: 't' });
    endRun();
    await svc.release({ ...project, id: 'p9', name: 'Old Shop' }, run('b3', 'aaa'));
    expect(started.at(-1)!.inputs.target.namespace).toBe('old-shop');
  });

  it('hands a new project\'s release its vault: the database and admin passwords the chart and jobs read from it', async () => {
    const ensured: string[] = [];
    const svc = new Stopped({
      store: db, runs, chartAt: async () => true, newId: () => 'r1',
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
    await db.releases.saveOdooRelease({ id: 'old', ownerId: 'bo', projectId: 'p1', pipelineRunId: 'x', commit: 'c', image: 'i:t', state: 'live', host: 'h', startedAt: 't', updatedAt: 't' });
    const svc = new Stopped({
      store: db, runs, chartAt: async () => true, newId: () => 'r1',
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

  it('carries what the app was last given into a vault that lost it, rather than making new passwords its database would refuse', async () => {
    const seeded: Record<string, string | undefined> = {};
    const name = newReleaseName(project);
    const delivered: Record<string, string> = { POSTGRES_PASSWORD: 'db-last-given', ODOO_ADMIN_PASSWORD: 'admin-last-given' };
    const svc = new Stopped({
      store: db, runs, chartAt: async () => true, newId: () => 'r1',
      secrets: {
        ensure: async (_entry, options) => {
          for (const key of ['POSTGRES_PASSWORD', 'ODOO_ADMIN_PASSWORD', 'NEVER_GIVEN']) seeded[key] = await options.seed?.(key);
          return { declared: [{ key: 'POSTGRES_PASSWORD', source: 'generated', describe: 'd' }], waiting: [] };
        },
        keep: async () => { throw new Error('nothing to carry over'); },
        chartKeepsOwnSecret: async () => false,
        onCluster: async (_cluster, namespace, secret, key) => (namespace === name && secret === `${name}-vault` ? delivered[key] : undefined),
      },
    });
    await svc.release(project, run('b1', 'abc'));
    expect(seeded).toEqual({ POSTGRES_PASSWORD: 'db-last-given', ODOO_ADMIN_PASSWORD: 'admin-last-given', NEVER_GIVEN: undefined });
  });

  it('does not release while a secret the type needs waits for the person, and says which', async () => {
    const svc = new Stopped({
      store: db, runs, chartAt: async () => true, newId: () => 'r1',
      secrets: {
        ensure: async () => ({ declared: [{ key: 'STRIPE_KEY', source: 'person', describe: 'd' }], waiting: ['STRIPE_KEY'] }),
        keep: async () => undefined,
        chartKeepsOwnSecret: async () => false,
        onCluster: async () => undefined,
      },
    });
    expect(await svc.release(project, run('b1', 'abc'))).toEqual({ status: 409, error: 'the project\'s secrets could not be put in its vault: waiting for the person to enter STRIPE_KEY' });
    expect(started).toEqual([]);
    expect((await db.releases.getOdooReleases('bo'))[0]).toMatchObject({ state: 'failed', reason: 'the project\'s secrets could not be put in its vault: waiting for the person to enter STRIPE_KEY' });
  });

  it('releases nothing for a build that changed nothing the app is built from, says why on the build, and still releases the first one', async () => {
    const asked: string[] = [];
    const svc = new Stopped({
      store: db, runs, chartAt: async () => true, newId: () => `r${(ids += 1)}`,
      decide: async (_project, since, commit) => { asked.push(`${since}..${commit}`); return commit === 'docs' ? { release: false, reason: 'only PLAN.md changed since abc' } : { release: true }; },
    });
    await db.releases.savePipelineRun(run('b1', 'abc'));
    await db.releases.savePipelineRun(run('b2', 'docs'));
    expect(await svc.release(project, run('b1', 'abc'))).toMatchObject({ state: 'preparing' });
    expect(await svc.release(project, run('b2', 'docs'))).toEqual({ skipped: 'only PLAN.md changed since abc' });
    expect(asked).toEqual(['abc..docs']);
    expect(started).toHaveLength(1);
    expect((await db.releases.getPipelineRuns()).find((entry) => entry.id === 'b2')?.releaseSkipped).toBe('only PLAN.md changed since abc');
  });

  it('refuses a project with no cluster, and a build with no image, and says so on the build', async () => {
    await db.releases.savePipelineRun(run('b1', 'abc'));
    await db.releases.savePipelineRun(run('b2', 'def'));
    expect(await service().release({ ...project, targetClusterId: undefined } as never, run('b1', 'abc'))).toEqual({ status: 409, error: 'the project has no cluster to deploy to' });
    expect(await service().release(project, { ...run('b2', 'def'), imageTag: undefined } as never)).toEqual({ status: 409, error: 'the build has no image to release' });
    expect((await db.releases.getPipelineRuns()).map((entry) => [entry.id, entry.status, entry.releaseRefused])).toEqual([['b1', 'succeeded', 'the project has no cluster to deploy to'], ['b2', 'succeeded', 'the build has no image to release']]);
    expect(await db.releases.getOdooReleases('bo')).toEqual([]);
  });
});

describe('a push that changes only the browser tests', () => {
  const svcWith = (changed: (since: string, commit: string) => Promise<string[]>) => new Stopped({
    store: db, runs, chartAt: async () => true, now, newId: () => `r${(ids += 1)}`,
    changed: async (_project, since, commit) => changed(since, commit),
  });
  const onlyTests = async () => ['e2e/sees-the-field.spec.ts'];

  it('runs the waiting preview\'s tests again with the new commit\'s specs, releasing nothing and setting nothing aside', async () => {
    const svc = svcWith(onlyTests);
    await db.releases.savePipelineRun(run('b1', 'abc'));
    await db.releases.savePipelineRun(run('b2', 'tests'));
    await svc.release(project, run('b1', 'abc'));
    await engineMarks('r1', { state: 'preview', slot: 'b', e2e: { state: 'passed', summary: '1 passed', startedAt: 't0', finishedAt: 't1' } });
    const note = 'only browser tests changed, and they ran on the waiting preview of abc';
    expect(await svc.release(project, run('b2', 'tests'))).toEqual({ skipped: note });
    expect(answered).toEqual(['p1: Run tests again']);
    expect(stopped).toEqual([]);
    expect(started).toHaveLength(1);
    expect((await db.releases.getOdooReleases('bo')).map((entry) => [entry.id, entry.state, entry.testsFrom])).toEqual([['r1', 'preview', 'tests']]);
    expect((await db.releases.getPipelineRuns()).find((entry) => entry.id === 'b2')?.releaseSkipped).toBe(note);
  });

  it('says on the build that the waiting preview takes the tests but cannot run them while its own still run, and keeps the commit for Run tests again', async () => {
    const svc = svcWith(onlyTests);
    await db.releases.savePipelineRun(run('b1', 'abc'));
    await db.releases.savePipelineRun(run('b2', 'tests'));
    await svc.release(project, run('b1', 'abc'));
    await engineMarks('r1', { state: 'preview', slot: 'b', e2e: { state: 'running', startedAt: 't0' } });
    expect(await svc.release(project, run('b2', 'tests'))).toEqual({ skipped: 'only browser tests changed; the waiting preview of abc takes them, but its browser tests are still running, so it cannot be tested again yet: Run tests again on its card runs them' });
    expect(answered).toEqual([]);
    expect((await db.releases.getOdooReleases('bo'))[0]).toMatchObject({ state: 'preview', testsFrom: 'tests', e2e: { state: 'running' } });
  });

  it('runs nothing when no preview waits, and says the tests run with the next release', async () => {
    const svc = svcWith(onlyTests);
    await db.releases.savePipelineRun(run('b1', 'abc'));
    await db.releases.savePipelineRun(run('b2', 'tests'));
    await svc.release(project, run('b1', 'abc'));
    await engineMarks('r1', { state: 'live', slot: 'a' });
    endRun();
    expect(await svc.release(project, run('b2', 'tests'))).toEqual({ skipped: 'only browser tests changed since abc, and nothing waits in preview to run them on; they run with the next release' });
    expect(answered).toEqual([]);
    expect(started).toHaveLength(1);
  });

  it('releases as before when anything else changed too, and refuses with the reason when what changed cannot be read', async () => {
    await db.releases.savePipelineRun(run('b1', 'abc'));
    await db.releases.savePipelineRun(run('b2', 'more'));
    await db.releases.savePipelineRun(run('b3', 'unread'));
    const svc = svcWith(async (_since, commit) => {
      if (commit === 'unread') throw new Error('Gitea answered 502');
      return ['e2e/a.spec.ts', 'addons/shop/models/order.py'];
    });
    await svc.release(project, run('b1', 'abc'));
    await engineMarks('r1', { state: 'live', slot: 'a' });
    endRun();
    expect(await svc.release(project, run('b2', 'more'))).toMatchObject({ state: 'preparing', commit: 'more' });
    await engineMarks('r2', { state: 'preview', slot: 'b' });
    expect(await svc.release(project, run('b3', 'unread'))).toEqual({ status: 409, error: 'what changed since more could not be read, so the build is not released: Gitea answered 502' });
    expect((await db.releases.getPipelineRuns()).find((entry) => entry.id === 'b3')?.releaseRefused).toBe('what changed since more could not be read, so the build is not released: Gitea answered 502');
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

  it('follows its run again while Temporal cannot say whether it runs, and settles it once Temporal answers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let away = 0;
      const unsure: ReleaseRuns = { ...runs, running: async (projectId) => { if (away > 0) { away -= 1; throw new Error('temporal is away'); } return runs.running(projectId); } };
      const svc = new Stopped({ store: db, runs: unsure, chartAt: async () => true, now, newId: () => `r${(ids += 1)}`, reopenMs: 1 });
      await svc.release(project, run('b1', 'abc'));
      away = 2;
      const following = svc.follow('bo', 'p1');
      endRun();
      await following;
      expect(warn.mock.calls.filter(([line]) => String(line).includes('cannot follow p1\'s release run (temporal is away)'))).toHaveLength(2);
      expect(await stateOf('r1')).toMatchObject({ state: 'failed', reason: 'the release stopped before it said how it went' });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a project that starts from a client\'s database', () => {
  const uploaded = { state: 'uploaded', mode: 'copy', bytes: 10, version: '20.0', modules: ['base', 'sale'], at: 't' };
  const importOf = async (): Promise<unknown> => (await db.projects.getProjects()).find((entry) => entry.id === 'p1')?.clientImport;

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
    expect(await importOf()).toMatchObject({ state: 'refused', missing: ['web_studio'], reason: containing('this project does not: web_studio') });
    const stored = (await db.projects.getProjects()).find((entry) => entry.id === 'p1')!;
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
    const svc = new Stopped({ store: db, runs, chartAt: async () => true, now, newId: () => `r${(ids += 1)}`, awaiting: (_owner, entry, built) => { waited.push(`${entry.id} ${built.commitSha}`); } });
    await db.releases.savePipelineRunInfo({ ...run('b1', 'abc'), startedAt: 't' } as never);
    expect(await svc.release({ ...project, clientImport: { state: 'awaited', mode: 'copy', bytes: 0, at: 't' } } as ProjectMetadata, run('b1', 'abc'))).toEqual({ skipped: 'waiting for the client\'s database: upload their backup on the project\'s Settings, or start without it there' });
    expect(started).toEqual([]);
    expect(waited).toEqual(['p1 abc']);
    expect((await db.releases.getPipelineRuns()).find((entry) => entry.id === 'b1')?.releaseHeld).toContain('waiting for the client\'s database');
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
    const ended = new Stopped({ store: db, runs: { ...runs, running: async () => false }, chartAt: async () => true, now });
    expect(await ended.decide('bo', 'r1', 'cutOver')).toEqual({ status: 409, error: 'no release is waiting for this preview, so it cannot be cut over: push again to release it' });
    expect(await svc.decide('cy', 'r1', 'discard')).toEqual({ status: 404, error: 'You have no release with that id' });
    await engineMarks('r1', { state: 'live' });
    expect(await svc.retest('bo', 'r1')).toEqual({ status: 409, error: 'the release is live, so it cannot be tested again' });
  });
});

describe('what the run records', () => {
  it('tells the person each change, and marks the deployment running with the live image, telling its owner each time it changes', async () => {
    const seen: string[] = [];
    const appsTold: string[] = [];
    const svc = new Stopped({ store: db, runs, chartAt: async () => true, now, newId: () => `r${(ids += 1)}`, notify: (_owner, release) => seen.push(`${release.id} ${release.state}`), deploymentChanged: (ownerId) => appsTold.push(ownerId) });
    await svc.release(project, run('b1', 'aaa'));
    expect(appsTold).toEqual(['bo']);
    await engineMarks('r1', { state: 'live', slot: 'a' });
    await runEnds(svc);
    expect(seen).toEqual(['r1 live']);
    expect((await db.infrastructure.getDeployments())[0]).toMatchObject({ status: 'running', gitappImageTag: 'reg/bo/shop:aaa' });
    expect(appsTold).toEqual(['bo', 'bo']);
  });

  it('keeps what the run records while the change before it is told, and tells the release as it is now', async () => {
    const seen: string[] = [];
    let recordsMeanwhile = true;
    const bound = <T extends object>(target: T, key: string | symbol): unknown => {
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    };
    const releases = new Proxy(db.releases, {
      get: (target, key) => key !== 'markOdooReleaseTold' ? bound(target, key) : async (id: string, updatedAt: string) => {
        if (recordsMeanwhile) {
          recordsMeanwhile = false;
          await engineMarks('r1', { state: 'preview', e2e: { state: 'passed', summary: '1 passed', startedAt: 't0', finishedAt: 't1' } });
        }
        return target.markOdooReleaseTold(id, updatedAt);
      },
    });
    const store = new Proxy(db, { get: (target, key) => key === 'releases' ? releases : bound(target, key) });
    let told!: () => void;
    const toldOnce = new Promise<void>((done) => { told = done; });
    const svc = new Stopped({ store, runs, chartAt: async () => true, now, newId: () => `r${(ids += 1)}`, notify: (_owner, release) => { seen.push(`${release.id} ${release.state} ${release.e2e?.state}`); told(); } });
    await svc.start();
    await svc.release(project, run('b1', 'aaa'));
    await engineMarks('r1', { state: 'preview', slot: 'b', e2e: { state: 'running', startedAt: 't0' } });
    await toldOnce;
    expect(seen).toEqual(['r1 preview passed']);
    expect((await stateOf('r1'))?.e2e?.state).toBe('passed');
    await runEnds(svc);
    await svc.stop();
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

  it('offers to go back to the release a cutover replaced once its run has ended, and starts the roll back agent with both releases', async () => {
    const svc = service();
    await twoReleases(svc);
    const live = (await stateOf('r2'))!;
    running = true;
    expect(await svc.rollBackOffer('bo', 'p1')).toBeUndefined();
    endRun();
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
    endRun();
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
    const deployment = (await db.infrastructure.getDeployments())[0]!;
    await db.infrastructure.saveDeploymentInfo({ id: deployment.id, localExposureUrl: 'http://shop.localhost:8000', previewLocalUrl: 'http://shop-preview.localhost:8000', publicExposureUrl: 'https://shop-x.dev' });
    expect(await svc.addresses('p1')).toEqual({ live: 'https://shop-x.dev', preview: 'http://shop-preview.localhost:8000' });
  });
});

describe('releasing a build again', () => {
  const deciding = () => new Stopped({
    store: db, runs, chartAt: async () => true, now, newId: () => `r${(ids += 1)}`,
    decide: async () => ({ release: false, reason: 'nothing changed since abc' }),
  });

  it('releases the same build without asking whether anything changed, and records which release it repeats', async () => {
    await db.releases.savePipelineRun(run('b1', 'abc'));
    await db.releases.saveOdooRelease({ id: 'live', ownerId: 'bo', projectId: 'p1', pipelineRunId: 'b0', commit: 'aaa', image: 'reg/bo/shop:aaa', state: 'live', host: 'h', startedAt: 't0', updatedAt: 't0' });
    await db.releases.saveOdooRelease({ id: 'old', ownerId: 'bo', projectId: 'p1', pipelineRunId: 'b1', commit: 'abc', image: 'reg/bo/shop:abc', state: 'discarded', host: 'h', startedAt: 't1', updatedAt: 't1' });
    const again = await deciding().releaseAgain('bo', project, 'old');
    expect(again).toMatchObject({ state: 'preparing', again: 'old', commit: 'abc', image: 'reg/bo/shop:abc', pipelineRunId: 'b1' });
    expect(started).toHaveLength(1);
  });

  it('queues behind a waiting preview and stops it, as a new build does', async () => {
    await db.releases.savePipelineRun(run('b1', 'abc'));
    await db.releases.saveOdooRelease({ id: 'waiting', ownerId: 'bo', projectId: 'p1', pipelineRunId: 'b1', commit: 'abc', image: 'reg/bo/shop:abc', state: 'preview', host: 'h', startedAt: 't1', updatedAt: 't1' });
    running = true;
    const svc = deciding();
    expect(await svc.releaseAgain('bo', project, 'waiting')).toMatchObject({ state: 'queued', again: 'waiting' });
    expect(stopped).toEqual(['p1']);
    await nextStarts(svc, 1);
    expect(started).toHaveLength(1);
  });

  it('refuses a release that is live or still in progress, one it does not know, and one whose build is gone', async () => {
    await db.releases.saveOdooRelease({ id: 'live', ownerId: 'bo', projectId: 'p1', pipelineRunId: 'b1', commit: 'abc', image: 'i', state: 'live', host: 'h', startedAt: 't', updatedAt: 't' });
    await db.releases.saveOdooRelease({ id: 'prep', ownerId: 'bo', projectId: 'p1', pipelineRunId: 'b1', commit: 'abc', image: 'i', state: 'preparing', host: 'h', startedAt: 't', updatedAt: 't' });
    await db.releases.saveOdooRelease({ id: 'lost', ownerId: 'bo', projectId: 'p1', pipelineRunId: 'gone', commit: 'abc', image: 'i', state: 'failed', host: 'h', startedAt: 't', updatedAt: 't' });
    expect(await deciding().releaseAgain('bo', project, 'live')).toEqual({ status: 409, error: 'the release is live, so its build cannot be released again' });
    expect(await deciding().releaseAgain('bo', project, 'prep')).toEqual({ status: 409, error: 'the release is preparing, so its build cannot be released again' });
    expect(await deciding().releaseAgain('bo', project, 'nope')).toEqual({ status: 404, error: 'This project has no release with that id' });
    expect(await deciding().releaseAgain('bo', project, 'lost')).toEqual({ status: 409, error: 'the build this release was made from is gone' });
    expect(started).toEqual([]);
  });
});

describe('the files a release changes', () => {
  const DIFF = [
    'diff --git a/addons/labels/models.py b/addons/labels/models.py', '--- a/addons/labels/models.py', '+++ b/addons/labels/models.py', '@@ -1 +1 @@', '-x = 1', '+x = 2',
    'diff --git a/PLAN.md b/PLAN.md', '--- a/PLAN.md', '+++ b/PLAN.md', '@@ -1 +1 @@', '-a', '+b',
  ].join('\n');
  const asked: string[] = [];
  const reading = () => new Stopped({
    store: db, runs, chartAt: async () => true, now,
    diff: async (_project, base, head) => { asked.push(`${base}..${head}`); return DIFF; },
    releaseWhen: async () => ['addons/**'],
  });
  const save = (id: string, commit: string, state: 'live' | 'preview' | 'superseded', extra: object = {}) =>
    db.releases.saveOdooRelease({ id, ownerId: 'bo', projectId: 'p1', pipelineRunId: id, commit, image: `i:${commit}`, state, host: 'h', startedAt: id, updatedAt: id, ...extra });

  beforeEach(() => { asked.length = 0; });

  it('compares a preview with what is live, the files the app is built from first', async () => {
    await save('one', 'aaa', 'live');
    await save('two', 'bbb', 'preview');
    const files = await reading().files('bo', project, 'two');
    expect(asked).toEqual(['aaa..bbb']);
    expect(files).toMatchObject({ against: { releaseId: 'one', commit: 'aaa', state: 'live' } });
    expect('files' in files && files.files.map((file) => [file.path, file.inApp, file.added, file.removed])).toEqual([['addons/labels/models.py', true, 1, 1], ['PLAN.md', false, 1, 1]]);
  });

  it('compares a live release with the one it replaced, and says when there is nothing to compare', async () => {
    await save('one', 'aaa', 'superseded', { replacedBy: 'two' });
    await save('two', 'bbb', 'live');
    expect(await reading().files('bo', project, 'two')).toMatchObject({ against: { releaseId: 'one' } });
    expect(await reading().files('bo', project, 'one')).toMatchObject({ against: { releaseId: 'two', state: 'live' } });
    expect(asked).toEqual(['aaa..bbb', 'bbb..aaa']);
    asked.length = 0;
    await db.releases.saveOdooRelease({ id: 'two', ownerId: 'bo', projectId: 'p1', pipelineRunId: 'two', commit: 'aaa', image: 'i', state: 'preview', host: 'h', startedAt: 'two', updatedAt: 'two' });
    await save('one', 'aaa', 'live');
    expect(await reading().files('bo', project, 'two')).toEqual({ against: { releaseId: 'one', commit: 'aaa', state: 'live' }, files: [], note: 'It is the same commit as what it is compared with, so no file differs.' });
    expect(asked).toEqual([]);
  });

  it('says so when the first release is the one live, and when nothing is live yet', async () => {
    await save('one', 'aaa', 'live');
    expect(await reading().files('bo', project, 'one')).toEqual({ files: [], note: 'This was the first release, so there is nothing before it to compare with.' });
    await save('one', 'aaa', 'superseded');
    await save('two', 'bbb', 'preview');
    expect(await reading().files('bo', project, 'two')).toEqual({ files: [], note: 'Nothing is live yet to compare it with.' });
  });
});
