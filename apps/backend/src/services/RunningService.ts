import { runningItems, type RunningItem, type RunningRecords, type RunningWorkflow } from '../lib/running.js';
import type { BenchSettings } from '../lib/bench.js';
import type { KeeperState } from './MemoryKeeperService.js';

export interface RunningView {
  items: RunningItem[];
  bench: { paused: boolean };
  keeper: KeeperState;
}

export type RunningOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409 | 503; error: string };

export interface RunningDeps {
  workflows: {
    list(ownerId: string): Promise<RunningWorkflow[] | undefined>;
    waiting(workflowId: string): Promise<{ asking: string[]; waitsFor: string[] } | undefined>;
    cancel(workflowId: string): Promise<'cancelled' | 'not-running' | 'unreachable'>;
  };
  records(ownerId: string): Promise<RunningRecords>;
  checks: { cancel(ownerId: string, id: string): Promise<boolean> };
  trees: { stop(ownerId: string, treeId: string): Promise<{ ok: boolean; error?: string | undefined }> };
  runs: { cancel(runId: string): Promise<void> };
  bench: { settings(ownerId: string): Promise<BenchSettings>; saveSettings(ownerId: string, value: unknown): Promise<{ saved: boolean; problems?: string[] | undefined }> };
  keeper: { state(ownerId: string): Promise<KeeperState>; setPaused(ownerId: string, paused: boolean): Promise<KeeperState> };
}

const pausedOf = (body: unknown): boolean | undefined => {
  const paused = (body as { paused?: unknown } | undefined)?.paused;
  return typeof paused === 'boolean' ? paused : undefined;
};

export class RunningService {
  constructor(private readonly deps: RunningDeps) {}

  private async items(ownerId: string): Promise<RunningItem[] | undefined> {
    const workflows = await this.deps.workflows.list(ownerId);
    if (!workflows) return undefined;
    const items = runningItems(workflows, await this.deps.records(ownerId));
    return Promise.all(items.map(async (item) => {
      if (item.cancel.via !== 'run' && item.cancel.via !== 'tree') return item;
      const waiting = await this.deps.workflows.waiting(item.workflowId).catch(() => undefined);
      return {
        ...item,
        ...(waiting?.asking.length ? { asking: waiting.asking } : {}),
        ...(waiting?.waitsFor.length ? { waitsFor: waiting.waitsFor } : {}),
      };
    }));
  }

  async view(ownerId: string): Promise<RunningOutcome<RunningView>> {
    const items = await this.items(ownerId);
    if (!items) return { ok: false, status: 503, error: 'Temporal is not reachable, so what runs cannot be read' };
    const [bench, keeper] = await Promise.all([this.deps.bench.settings(ownerId), this.deps.keeper.state(ownerId)]);
    return { ok: true, value: { items, bench: { paused: !bench.enabled }, keeper } };
  }

  async cancel(ownerId: string, workflowId: string): Promise<RunningOutcome<{ cancelling: true }>> {
    const item = (await this.items(ownerId))?.find((entry) => entry.workflowId === workflowId);
    if (!item) return { ok: false, status: 404, error: 'Nothing of yours is running under that id' };
    const how = item.cancel;
    switch (how.via) {
      case 'none':
        return { ok: false, status: 409, error: `${item.title} cannot be cancelled: ${how.why}` };
      case 'check':
        if (!(await this.deps.checks.cancel(ownerId, how.id))) return { ok: false, status: 409, error: 'those checks are no longer running' };
        break;
      case 'tree': {
        const stopped = await this.deps.trees.stop(ownerId, how.treeId);
        if (!stopped.ok) return { ok: false, status: 409, error: stopped.error ?? 'the tree is not running' };
        break;
      }
      case 'run':
        await this.deps.runs.cancel(how.runId);
        break;
      case 'workflow': {
        const outcome = await this.deps.workflows.cancel(workflowId);
        if (outcome === 'unreachable') return { ok: false, status: 503, error: 'Temporal is not reachable' };
        if (outcome === 'not-running') return { ok: false, status: 409, error: 'it is no longer running' };
        break;
      }
    }
    return { ok: true, value: { cancelling: true } };
  }

  async pauseBench(ownerId: string, body: unknown): Promise<RunningOutcome<{ paused: boolean }>> {
    const paused = pausedOf(body);
    if (paused === undefined) return { ok: false, status: 400, error: 'say "paused": true or false' };
    const current = await this.deps.bench.settings(ownerId);
    const saved = await this.deps.bench.saveSettings(ownerId, { ...current, enabled: !paused });
    if (!saved.saved) return { ok: false, status: 400, error: (saved.problems ?? []).join('; ') || 'the bench settings were not saved' };
    return { ok: true, value: { paused } };
  }

  async pauseKeeper(ownerId: string, body: unknown): Promise<RunningOutcome<KeeperState>> {
    const paused = pausedOf(body);
    if (paused === undefined) return { ok: false, status: 400, error: 'say "paused": true or false' };
    return { ok: true, value: await this.deps.keeper.setPaused(ownerId, paused) };
  }
}
