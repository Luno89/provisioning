import type { RunningItem } from '../lib/running.js';
import type { WorkFailure } from '../lib/work-failures.js';
import type { BrokenWorkload, ClusterContents } from './ClusterContentsService.js';
import type { Overview, Viewer } from '../../monitoring/services/MonitoringService.js';
import type { RunningOutcome, RunningView } from './RunningService.js';

export interface InfrastructureOverview {
  monitoring: Overview;
  workloads: BrokenWorkload[];
  waiting: RunningItem[];
  running: number;
  runningProblem?: string | undefined;
  failures: WorkFailure[];
}

export interface InfrastructureViewDeps {
  monitoring: { overview(viewer: Viewer): Promise<Overview> };
  contents: { broken(viewer: Viewer): Promise<BrokenWorkload[]>; contents(viewer: Viewer, clusterId: string): Promise<ClusterContents> };
  running: { view(ownerId: string): Promise<RunningOutcome<RunningView>> };
  failures: { shown(ownerId: string): Promise<WorkFailure[]>; clear(ownerId: string, ids: readonly string[] | 'all'): Promise<number> };
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
    const [monitoring, broken, running, failures] = await Promise.all([
      this.deps.monitoring.overview(viewer),
      this.deps.contents.broken(viewer).catch(() => []),
      this.deps.running.view(viewer.id),
      this.deps.failures.shown(viewer.id),
    ]);
    const appsTold = new Set(monitoring.attention.filter((entry) => entry.subject.kind === 'app').map((entry) => entry.subject.id));
    const workloads = broken.filter((workload) => !(workload.about.kind === 'app' && appsTold.has(workload.about.id)));
    return {
      monitoring,
      workloads,
      waiting: running.ok ? waitingOnPerson(running.value.items) : [],
      running: running.ok ? running.value.items.length : 0,
      ...(running.ok ? {} : { runningProblem: running.error }),
      failures,
    };
  }

  cluster(viewer: Viewer, clusterId: string): Promise<ClusterContents> {
    return this.deps.contents.contents(viewer, clusterId);
  }

  clearFailures(viewer: Viewer, ids: readonly string[] | 'all'): Promise<number> {
    return this.deps.failures.clear(viewer.id, ids);
  }
}
