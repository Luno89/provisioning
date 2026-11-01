import type { SignalView } from '../../engine/index.js';
import type { RunningItem } from '../lib/running.js';
import type { WorkFailure } from '../lib/work-failures.js';
import type { BrokenWorkload, ClusterContents } from './ClusterContentsService.js';
import type { KoalaView, Overview, Viewer } from '../../monitoring/index.js';
import type { RunningOutcome, RunningView } from './RunningService.js';

export interface InfrastructureOverview {
  monitoring: Overview;
  koala: KoalaView;
  workloads: BrokenWorkload[];
  waiting: RunningItem[];
  running: number;
  runningProblem?: string | undefined;
  failures: WorkFailure[];
  root?: RootReach | undefined;
  signals: SignalView[];
}

export interface RootReach {
  rootUrl: string;
  reachable: boolean;
  down: boolean;
  unreachableSince?: string | undefined;
  lastSeenAt?: string | undefined;
}

export interface InfrastructureViewDeps {
  monitoring: { overview(viewer: Viewer): Promise<Overview>; koala(viewer: Viewer): Promise<KoalaView> };
  contents: { broken(viewer: Viewer): Promise<BrokenWorkload[]>; contents(viewer: Viewer, clusterId: string): Promise<ClusterContents> };
  running: { view(ownerId: string): Promise<RunningOutcome<RunningView>> };
  failures: { shown(ownerId: string): Promise<WorkFailure[]>; clear(ownerId: string, ids: readonly string[] | 'all'): Promise<number> };
  root?: (() => RootReach | undefined) | undefined;
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
    const [monitoring, koala, broken, running, failures, signals] = await Promise.all([
      this.deps.monitoring.overview(viewer),
      this.deps.monitoring.koala(viewer),
      this.deps.contents.broken(viewer).catch((err: unknown) => {
        console.warn(`[InfrastructureView] broken workloads could not be read for ${viewer.id}: ${(err as Error).message}`);
        return [];
      }),
      this.deps.running.view(viewer.id),
      this.deps.failures.shown(viewer.id),
      this.deps.signals ? this.deps.signals.open(viewer.id) : Promise.resolve([]),
    ]);
    const appsTold = new Set(monitoring.attention.filter((entry) => entry.subject.kind === 'app').map((entry) => entry.subject.id));
    const workloads = broken.filter((workload) => !(workload.about.kind === 'app' && appsTold.has(workload.about.id)));
    return {
      monitoring,
      koala,
      workloads,
      waiting: running.ok ? waitingOnPerson(running.value.items) : [],
      running: running.ok ? running.value.items.length : 0,
      ...(running.ok ? {} : { runningProblem: running.error }),
      failures,
      signals,
      ...(this.deps.root?.() ? { root: this.deps.root()! } : {}),
    };
  }

  cluster(viewer: Viewer, clusterId: string): Promise<ClusterContents> {
    return this.deps.contents.contents(viewer, clusterId);
  }

  clearFailures(viewer: Viewer, ids: readonly string[] | 'all'): Promise<number> {
    return this.deps.failures.clear(viewer.id, ids);
  }
}
