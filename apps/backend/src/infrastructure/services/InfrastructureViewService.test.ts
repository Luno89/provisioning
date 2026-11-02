import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Overview, Viewer } from '../../monitoring/index.js';
import type { RunningItem } from '../lib/running.js';
import type { WorkFailure } from '../lib/work-failures.js';
import type { BrokenWorkload, ClusterContents } from './ClusterContentsService.js';
import { idsToClear, InfrastructureViewService, waitingOnPerson, type InfrastructureViewDeps, type RootReach } from './InfrastructureViewService.js';
import type { RunningView } from './RunningService.js';

const viewer = { id: 'person-1' } as Viewer;
const item = (workflowId: string, over: Partial<RunningItem> = {}): RunningItem => ({ workflowId, kind: 'tree', title: workflowId, since: 'x', opens: { kind: 'tree', id: 't' }, cancel: { how: 'workflow' }, ...over }) as unknown as RunningItem;
const broken = (name: string, about: BrokenWorkload['about']): BrokenWorkload => ({ name, about }) as unknown as BrokenWorkload;

function deps(over: { attention?: Overview['attention']; broken?: BrokenWorkload[]; running?: Awaited<ReturnType<InfrastructureViewDeps['running']['view']>>; root?: RootReach | undefined; signals?: boolean } = {}) {
  const monitoring = mock<InfrastructureViewDeps['monitoring']>();
  monitoring.overview.mockResolvedValue({ attention: over.attention ?? [] } as Overview);
  monitoring.koala.mockResolvedValue({ state: 'ok' } as never);
  const contents = mock<InfrastructureViewDeps['contents']>();
  contents.broken.mockResolvedValue(over.broken ?? []);
  const running = mock<InfrastructureViewDeps['running']>();
  running.view.mockResolvedValue(over.running ?? { ok: true, value: { items: [] } as unknown as RunningView });
  const failures = mock<InfrastructureViewDeps['failures']>();
  failures.shown.mockResolvedValue([{ id: 'run:a' } as WorkFailure]);
  const signals = mock<NonNullable<InfrastructureViewDeps['signals']>>();
  signals.open.mockResolvedValue([{ id: 's1' } as never]);
  const all: InfrastructureViewDeps = { monitoring, contents, running, failures, ...(over.root ? { root: () => over.root } : {}), ...(over.signals ? { signals } : {}) };
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
    expect(overview.root).toBeUndefined();
    expect(overview.runningProblem).toBeUndefined();
  });

  it('leaves out a broken workload of an app monitoring already says needs attention', async () => {
    const { all } = deps({
      attention: [{ subject: { kind: 'app', id: 'app-1' } }] as never,
      broken: [broken('w1', { kind: 'app', id: 'app-1' } as never), broken('w2', { kind: 'app', id: 'app-2' } as never), broken('w3', { kind: 'koala' } as never)],
    });
    expect((await new InfrastructureViewService(all).overview(viewer)).workloads.map((workload) => workload.name)).toEqual(['w2', 'w3']);
  });

  it('shows no broken workloads, and says why in the log, when they cannot be read', async () => {
    const { all, contents } = deps();
    contents.broken.mockRejectedValue(new Error('kubectl is away'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await new InfrastructureViewService(all).overview(viewer)).workloads).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[InfrastructureView] broken workloads could not be read for person-1: kubectl is away');
    warn.mockRestore();
  });

  it('says why running work could not be read instead of showing none', async () => {
    const { all } = deps({ running: { ok: false, status: 503, error: 'Temporal is not reachable' } });
    expect(await new InfrastructureViewService(all).overview(viewer)).toMatchObject({ running: 0, waiting: [], runningProblem: 'Temporal is not reachable' });
  });

  it('carries root\'s reachability and the open signals when it has them', async () => {
    const root: RootReach = { rootUrl: 'https://app.example.com', reachable: false, down: true };
    const { all } = deps({ root, signals: true });
    expect(await new InfrastructureViewService(all).overview(viewer)).toMatchObject({ root, signals: [{ id: 's1' }] });
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
