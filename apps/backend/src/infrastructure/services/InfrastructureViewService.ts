import type { SignalView } from '../../engine/index.js';
import type { RunningItem } from '../lib/running.js';
import type { WorkFailure } from '../lib/work-failures.js';
import type { BrokenAcrossClusters, BrokenWorkload, ClusterContents, UnreadCluster } from './ClusterContentsService.js';
import type { KoalaView, Overview, Viewer } from '../../monitoring/index.js';
import type { RunningOutcome, RunningView } from './RunningService.js';
import { allowed, downAcross, type DependencyDown, type DependencyStateRow } from '../../platform/index.js';

export interface InfrastructureOverview {
  monitoring: Overview;
  koala: KoalaView;
  workloads: BrokenWorkload[];
  unreadClusters: UnreadCluster[];
  waiting: RunningItem[];
  running: number;
  runningProblem?: string | undefined;
  failures: WorkFailure[];
  dependencies: DependencyDown[];
  dependenciesUnread?: string | undefined;
  signals: SignalView[];
}

export interface InfrastructureViewDeps {
  monitoring: { overview(viewer: Viewer): Promise<Overview>; koala(viewer: Viewer): Promise<KoalaView> };
  contents: { broken(viewer: Viewer): Promise<BrokenAcrossClusters>; contents(viewer: Viewer, clusterId: string): Promise<ClusterContents> };
  running: { view(ownerId: string): Promise<RunningOutcome<RunningView>> };
  failures: { shown(ownerId: string): Promise<WorkFailure[]>; clear(ownerId: string, ids: readonly string[] | 'all'): Promise<number> };
  dependencies?: { own(): DependencyDown[]; workers(): Promise<DependencyStateRow[]> } | undefined;
  signals?: { open(ownerId: string): Promise<SignalView[]> } | undefined;
}

export const waitingOnPerson = (items: readonly RunningItem[]): RunningItem[] =>
  items.filter((item) => (item.asking?.length ?? 0) > 0 || (item.waitsFor?.length ?? 0) > 0);

export function idsToClear(body: unknown): readonly string[] | 'all' | undefined {
  const ids = (body as { ids?: unknown } | undefined)?.ids;
  if (ids === undefined) return 'all';
  if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) return ids as string[];
  return undefined;
}

export class InfrastructureViewService {
  constructor(private readonly deps: InfrastructureViewDeps) {}

  async overview(viewer: Viewer): Promise<InfrastructureOverview> {
    const seesDependencies = this.deps.dependencies && allowed(viewer, 'see-platform-dependencies', { kind: 'install' });
    const [monitoring, koala, broken, running, failures, signals, dependencies] = await Promise.all([
      this.deps.monitoring.overview(viewer),
      this.deps.monitoring.koala(viewer),
      this.deps.contents.broken(viewer),
      this.deps.running.view(viewer.id),
      this.deps.failures.shown(viewer.id),
      this.deps.signals ? this.deps.signals.open(viewer.id) : Promise.resolve([]),
      seesDependencies ? this.dependencies() : Promise.resolve<{ down: DependencyDown[]; unread?: string }>({ down: [] }),
    ]);
    const appsTold = new Set(monitoring.attention.filter((entry) => entry.subject.kind === 'app').map((entry) => entry.subject.id));
    const workloads = broken.workloads.filter((workload) => !(workload.about.kind === 'app' && appsTold.has(workload.about.id)));
    return {
      monitoring,
      koala,
      workloads,
      unreadClusters: broken.unread,
      waiting: running.ok ? waitingOnPerson(running.value.items) : [],
      running: running.ok ? running.value.items.length : 0,
      ...(running.ok ? {} : { runningProblem: running.error }),
      failures,
      dependencies: dependencies.down,
      ...(dependencies.unread ? { dependenciesUnread: dependencies.unread } : {}),
      signals,
    };
  }

  private async dependencies(): Promise<{ down: DependencyDown[]; unread?: string }> {
    const states = this.deps.dependencies!;
    try {
      return { down: downAcross(states.own(), await states.workers()) };
    } catch (err) {
      return { down: downAcross(states.own(), []), unread: (err as Error).message };
    }
  }

  cluster(viewer: Viewer, clusterId: string): Promise<ClusterContents> {
    return this.deps.contents.contents(viewer, clusterId);
  }

  clearFailures(viewer: Viewer, ids: readonly string[] | 'all'): Promise<number> {
    return this.deps.failures.clear(viewer.id, ids);
  }
}
