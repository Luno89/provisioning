import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Overview, Viewer } from '../../monitoring/index.js';
import type { RunningItem } from '../lib/running.js';
import type { WorkFailure } from '../lib/work-failures.js';
import type { BrokenWorkload, ClusterContents, UnreadCluster } from './ClusterContentsService.js';
import { idsToClear, InfrastructureViewService, waitingOnPerson, type InfrastructureViewDeps } from './InfrastructureViewService.js';
import type { DependencyDown, Principal } from '../../platform/index.js';
import type { RunningView } from './RunningService.js';

const viewer = { id: 'person-1' } as Viewer;
const item = (workflowId: string, over: Partial<RunningItem> = {}): RunningItem => ({ workflowId, kind: 'tree', title: workflowId, since: 'x', opens: { kind: 'tree', id: 't' }, cancel: { how: 'workflow' }, ...over }) as unknown as RunningItem;
const broken = (name: string, about: BrokenWorkload['about']): BrokenWorkload => ({ name, about }) as unknown as BrokenWorkload;

function deps(over: { attention?: Overview['attention']; broken?: BrokenWorkload[]; unread?: UnreadCluster[]; running?: Awaited<ReturnType<InfrastructureViewDeps['running']['view']>>; dependencies?: DependencyDown[] | undefined; signals?: boolean } = {}) {
  const monitoring = mock<InfrastructureViewDeps['monitoring']>();
  monitoring.overview.mockResolvedValue({ attention: over.attention ?? [] } as Overview);
  monitoring.koala.mockResolvedValue({ state: 'ok' } as never);
  const contents = mock<InfrastructureViewDeps['contents']>();
  contents.broken.mockResolvedValue({ workloads: over.broken ?? [], unread: over.unread ?? [] });
  const running = mock<InfrastructureViewDeps['running']>();
  running.view.mockResolvedValue(over.running ?? { ok: true, value: { items: [] } as unknown as RunningView });
  const failures = mock<InfrastructureViewDeps['failures']>();
  failures.shown.mockResolvedValue([{ id: 'run:a' } as WorkFailure]);
  const signals = mock<NonNullable<InfrastructureViewDeps['signals']>>();
  signals.open.mockResolvedValue([{ id: 's1' } as never]);
  const all: InfrastructureViewDeps = { monitoring, contents, running, failures, ...(over.dependencies ? { dependencies: async () => over.dependencies! } : {}), ...(over.signals ? { signals } : {}) };
  return { all, monitoring, contents, running, failures, signals };
}

describe('waitingOnPerson', () => {
  it('keeps the work that asks a question or waits for a step', () => {
    const items = [item('a'), item('b', { asking: ['allow?'] as never }), item('c', { waitsFor: ['Cut over'] as never }), item('d', { asking: [] as never })];
    expect(waitingOnPerson(items).map((entry) => entry.workflowId)).toEqual(['b', 'c']);
  });
});

describe('idsToClear', () => {
  it('clears everything when no ids are sent, only the ones named when a list is, and nothing sensible when it is not a list of text', () => {
    expect(idsToClear({})).toBe('all');
    expect(idsToClear(undefined)).toBe('all');
    expect(idsToClear({ ids: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(idsToClear({ ids: [1] })).toBeUndefined();
    expect(idsToClear({ ids: 'a' })).toBeUndefined();
  });
});

describe('InfrastructureViewService', () => {
  it('puts the overview together from what monitoring, running work and failures say', async () => {
    const { all } = deps({ running: { ok: true, value: { items: [item('r1'), item('r2', { asking: ['q'] as never })] } as unknown as RunningView } });
    const overview = await new InfrastructureViewService(all).overview(viewer);
    expect(overview).toMatchObject({ running: 2, waiting: [{ workflowId: 'r2' }], failures: [{ id: 'run:a' }], signals: [], koala: { state: 'ok' } });
    expect(overview.dependencies).toEqual([]);
    expect(overview.runningProblem).toBeUndefined();
  });

  it('leaves out a broken workload of an app monitoring already says needs attention', async () => {
    const { all } = deps({
      attention: [{ subject: { kind: 'app', id: 'app-1' } }] as never,
      broken: [broken('w1', { kind: 'app', id: 'app-1' } as never), broken('w2', { kind: 'app', id: 'app-2' } as never), broken('w3', { kind: 'koala' } as never)],
    });
    expect((await new InfrastructureViewService(all).overview(viewer)).workloads.map((workload) => workload.name)).toEqual(['w2', 'w3']);
  });

  it('names each cluster whose workloads could not be read', async () => {
    const unread = [{ clusterId: 'c1', clusterName: 'desk', problem: 'it does not answer (connection refused)' }];
    const { all } = deps({ unread });
    expect(await new InfrastructureViewService(all).overview(viewer)).toMatchObject({ workloads: [], unreadClusters: unread });
  });

  it('fails the overview, saying why, when the clusters to read cannot be listed', async () => {
    const { all, contents } = deps();
    contents.broken.mockRejectedValue(new Error('the database is away'));
    await expect(new InfrastructureViewService(all).overview(viewer)).rejects.toThrow('the database is away');
  });

  it('says why running work could not be read instead of showing none', async () => {
    const { all } = deps({ running: { ok: false, status: 503, error: 'Temporal is not reachable' } });
    expect(await new InfrastructureViewService(all).overview(viewer)).toMatchObject({ running: 0, waiting: [], runningProblem: 'Temporal is not reachable' });
  });

  it('carries the open signals when it has them', async () => {
    const { all } = deps({ signals: true });
    expect(await new InfrastructureViewService(all).overview(viewer)).toMatchObject({ signals: [{ id: 's1' }] });
  });

  it('carries the dependencies that are down, root among them, to whoever runs this Koala and to nobody else', async () => {
    const down: DependencyDown[] = [
      { dependency: 'root', name: 'Koala\'s root', since: '2026-10-29T10:00:00.000Z', reason: 'this instance\'s connection to it is closed', process: 'backend', where: 'https://app.example.com' },
      { dependency: 'gitea', name: 'Gitea', since: '2026-10-29T10:05:00.000Z', reason: 'it refused the connection (ECONNREFUSED)', process: 'worker-engine' },
    ];
    const { all } = deps({ dependencies: down });
    const owner: Principal = { kind: 'person', id: 'owner', claims: [{ role: 'person' }, { role: 'operator' }, { role: 'instance-owner' }] };
    const member: Principal = { kind: 'person', id: 'member', claims: [{ role: 'person' }] };
    expect((await new InfrastructureViewService(all).overview(owner)).dependencies).toEqual(down);
    expect((await new InfrastructureViewService(all).overview(member)).dependencies).toEqual([]);
  });

  it('reads a cluster\'s contents and clears failures as the viewer', async () => {
    const { all, contents, failures } = deps();
    contents.contents.calledWith(viewer, 'c1').mockResolvedValue({ workloads: [] } as unknown as ClusterContents);
    failures.clear.calledWith('person-1', 'all').mockResolvedValue(3);
    const service = new InfrastructureViewService(all);
    expect(await service.cluster(viewer, 'c1')).toEqual({ workloads: [] });
    expect(await service.clearFailures(viewer, 'all')).toBe(3);
  });
});
