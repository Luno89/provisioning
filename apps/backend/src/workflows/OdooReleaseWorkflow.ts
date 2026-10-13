import { CancellationScope, condition, defineQuery, defineSignal, isCancellation, proxyActivities, setHandler } from '@temporalio/workflow';
import type { OdooReleaseActivities, ReleaseSource, ReleaseTarget } from '../activities/OdooReleaseActivities.js';
import type { ReleaseBrowserTestActivities } from '../activities/ReleaseBrowserTestsActivity.js';
import { DEFAULT_ENGINE_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import type { ReleaseE2E } from '../lib/release-e2e.js';
import { databaseOf, filestoreJob, helmSets, idleOf, odooJob, splitImage, type ReleaseState, type ReleaseVault, type Slot, type SlotState } from '../lib/odoo-release.js';

export interface ReleaseBuild {
  releaseId: string;
  image: string;
  source: ReleaseSource;
  vault?: ReleaseVault | undefined;
}

export interface OdooReleaseInput {
  target: ReleaseTarget;
  host: string;
  previewHost: string;
  ownerId: string;
  e2eMinutes: number;
}

export interface ReleaseProgress {
  state: ReleaseState;
  slot?: Slot | undefined;
  reason?: string | undefined;
  e2e?: ReleaseE2E | undefined;
  restoredAt?: string | undefined;
}

export interface ReleaseRollBack {
  from: string;
  to: ReleaseBuild;
}

export const releaseBuildSignal = defineSignal<[ReleaseBuild]>('releaseBuild');
export const cutOverSignal = defineSignal<[string]>('cutOver');
export const discardSignal = defineSignal<[string]>('discard');
export const retestSignal = defineSignal<[string]>('retest');
export const rollBackSignal = defineSignal<[ReleaseRollBack]>('rollBack');
export const releasesQuery = defineQuery<Record<string, ReleaseProgress>>('releases');

const quick = proxyActivities<Pick<OdooReleaseActivities, 'OdooReleaseStateActivity' | 'OdooReleaseModulesActivity' | 'OdooReleaseApplyActivity' | 'OdooReleaseInstalledActivity' | 'OdooReleaseScaleActivity' | 'OdooReleaseCopyDatabaseActivity' | 'OdooReleaseQuietActivity' | 'OdooReleaseVaultActivity'>>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 3 },
});

const long = proxyActivities<Pick<OdooReleaseActivities, 'OdooReleaseWaitActivity' | 'OdooReleaseJobActivity'>>({
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});

const browser = proxyActivities<ReleaseBrowserTestActivities>({
  taskQueue: DEFAULT_ENGINE_TASK_QUEUE,
  startToCloseTimeout: '2 hours',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});

const POSTGRES_READY_MS = 10 * 60_000;
const SLOT_READY_MS = 15 * 60_000;
const JOB_MS = 30 * 60_000;

const reasonOf = (err: unknown): string => {
  let reason = 'the release failed';
  for (let at = err as { message?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
    if (typeof at.message === 'string' && at.message) reason = at.message;
  }
  return reason;
};

export async function OdooReleaseWorkflow(input: OdooReleaseInput): Promise<Record<string, ReleaseProgress>> {
  const { target } = input;
  const pending: ReleaseBuild[] = [];
  const progress: Record<string, ReleaseProgress> = {};
  const decisions = new Map<string, 'cutOver' | 'discard'>();
  const retests = new Set<string>();
  const rollBacks: ReleaseRollBack[] = [];

  setHandler(releaseBuildSignal, (build) => { pending.push(build); });
  setHandler(cutOverSignal, (releaseId) => { if (!decisions.has(releaseId)) decisions.set(releaseId, 'cutOver'); });
  setHandler(discardSignal, (releaseId) => { if (!decisions.has(releaseId)) decisions.set(releaseId, 'discard'); });
  setHandler(retestSignal, (releaseId) => { retests.add(releaseId); });
  setHandler(rollBackSignal, (rollBack) => { rollBacks.push(rollBack); });
  setHandler(releasesQuery, () => progress);

  const mark = (releaseId: string, state: ReleaseState, extra: Partial<ReleaseProgress> = {}) => {
    progress[releaseId] = { ...progress[releaseId], ...extra, state };
  };

  const apply = (build: ReleaseBuild, state: SlotState, previewHost?: string) => quick.OdooReleaseApplyActivity({
    target,
    source: build.source,
    sets: helmSets({ repository: splitImage(build.image).repository, state, host: input.host, ...(previewHost ? { previewHost } : {}) }),
  });

  const job = (kind: string, slot: Slot, manifest: Record<string, unknown>) =>
    long.OdooReleaseJobActivity({ target, name: `${target.release}-${kind}-${slot}`, manifest, timeoutMs: JOB_MS });

  const slotReady = (slot: Slot) => long.OdooReleaseWaitActivity({ target, workload: `deployment/${target.release}-odoo-${slot}`, timeoutMs: SLOT_READY_MS });

  const prepare = async (build: ReleaseBuild, slot: Slot, from: Slot, modules: string[], quiet: boolean) => {
    await quick.OdooReleaseCopyDatabaseActivity({ target, from: databaseOf(from), to: databaseOf(slot) });
    if (quiet) await quick.OdooReleaseQuietActivity({ target, database: databaseOf(slot) });
    await job('filestore', slot, filestoreJob({ name: '', release: target.release, image: build.image, from: databaseOf(from), to: databaseOf(slot) }));
    const installed = new Set(await quick.OdooReleaseInstalledActivity({ target, database: databaseOf(slot) }));
    await job('upgrade', slot, odooJob({
      name: '',
      release: target.release,
      image: build.image,
      database: databaseOf(slot),
      install: modules.filter((module) => !installed.has(module)),
      update: modules.filter((module) => installed.has(module)),
      vault: build.vault,
    }));
  };

  const browserTests = (build: ReleaseBuild, slot: Slot) => {
    const scope = new CancellationScope();
    const startedAt = new Date().toISOString();
    progress[build.releaseId] = { ...progress[build.releaseId]!, e2e: { state: 'running', startedAt } };
    const settle = (e2e: ReleaseE2E) => { progress[build.releaseId] = { ...progress[build.releaseId]!, e2e }; };
    const done = scope.run(() => browser.ReleaseBrowserTestsActivity({
      target,
      source: build.source,
      ownerId: input.ownerId,
      releaseId: build.releaseId,
      slot,
      image: build.image,
      minutes: input.e2eMinutes,
    })).then(settle, (err: unknown) => settle(isCancellation(err)
      ? { state: 'stopped', reason: 'stopped before the tests finished', startedAt, finishedAt: new Date().toISOString() }
      : { state: 'unavailable', reason: reasonOf(err), startedAt, finishedAt: new Date().toISOString() }));
    return { scope, done };
  };

  const rollBack = async ({ from, to }: ReleaseRollBack) => {
    mark(from, 'rolling-back');
    let started: Slot | undefined;
    try {
      const current = await quick.OdooReleaseStateActivity(target);
      const kept = idleOf(current.live);
      if (current.tags[kept] !== splitImage(to.image).tag) throw new Error(`slot ${kept} no longer holds the release of ${to.source.commit.slice(0, 8)}`);
      started = kept;
      await quick.OdooReleaseScaleActivity({ target, slot: kept, replicas: 1 });
      await slotReady(kept);
      await apply(to, { ...current, live: kept, tags: { ...current.tags, [current.live]: undefined } });
      started = undefined;
      await slotReady(kept);
      mark(to.releaseId, 'live', { slot: kept, restoredAt: new Date().toISOString() });
      mark(from, 'rolled-back', { reason: `rolled back to the release of ${to.source.commit.slice(0, 8)}` });
    } catch (err) {
      if (started) await quick.OdooReleaseScaleActivity({ target, slot: started, replicas: 0 }).catch(() => undefined);
      mark(from, 'live', { reason: `the rollback failed: ${reasonOf(err)}` });
    }
  };

  await condition(() => pending.length > 0 || rollBacks.length > 0, '1 minute');
  while (pending.length > 0 || rollBacks.length > 0) {
    const back = rollBacks.shift();
    if (back) {
      await rollBack(back);
      continue;
    }
    const build = pending.shift()!;
    mark(build.releaseId, 'preparing');
    let maintenance: Slot | undefined;
    try {
      const current = await quick.OdooReleaseStateActivity(target);
      const tag = splitImage(build.image).tag;
      const modules = await quick.OdooReleaseModulesActivity(build.source);
      if (build.vault) await quick.OdooReleaseVaultActivity({ target, vault: build.vault });

      if (!current.installed || !current.tags[current.live]) {
        const empty: SlotState = { installed: true, live: 'a', tags: { a: undefined, b: undefined } };
        mark(build.releaseId, 'preparing', { slot: 'a' });
        await apply(build, empty);
        await long.OdooReleaseWaitActivity({ target, workload: `statefulset/${target.release}-postgres`, timeoutMs: POSTGRES_READY_MS });
        await job('init', 'a', odooJob({ name: '', release: target.release, image: build.image, database: databaseOf('a'), install: ['base', ...modules], update: [], vault: build.vault }));
        await apply(build, { ...empty, tags: { a: tag, b: undefined } });
        await slotReady('a');
        mark(build.releaseId, 'live', { slot: 'a' });
        continue;
      }

      const idle = idleOf(current.live);
      const cleared: SlotState = { ...current, tags: { ...current.tags, [idle]: undefined } };
      mark(build.releaseId, 'preparing', { slot: idle });
      await apply(build, cleared);
      await prepare(build, idle, current.live, modules, true);
      const ready: SlotState = { ...cleared, tags: { ...cleared.tags, [idle]: tag } };
      await apply(build, ready, input.previewHost);
      await slotReady(idle);
      mark(build.releaseId, 'preview', { slot: idle });

      retests.delete(build.releaseId);
      let gate = browserTests(build, idle);
      const settled = () => decisions.has(build.releaseId) || pending.length > 0;
      for (;;) {
        await condition(() => settled() || retests.has(build.releaseId));
        if (settled()) break;
        retests.delete(build.releaseId);
        gate.scope.cancel();
        await gate.done;
        gate = browserTests(build, idle);
      }
      gate.scope.cancel();
      await gate.done;
      const decision = decisions.get(build.releaseId);
      if (!decision) {
        mark(build.releaseId, 'superseded', { reason: 'a newer build took its place' });
        continue;
      }
      if (decision === 'discard') {
        await apply(build, cleared);
        mark(build.releaseId, 'discarded');
        continue;
      }

      mark(build.releaseId, 'cutting-over');
      maintenance = current.live;
      await quick.OdooReleaseScaleActivity({ target, slot: current.live, replicas: 0 });
      await apply(build, cleared);
      await prepare(build, idle, current.live, modules, false);
      await apply(build, { ...ready, live: idle });
      maintenance = undefined;
      await quick.OdooReleaseScaleActivity({ target, slot: current.live, replicas: 0 });
      await slotReady(idle);
      mark(build.releaseId, 'live', { slot: idle });
    } catch (err) {
      if (maintenance) await quick.OdooReleaseScaleActivity({ target, slot: maintenance, replicas: 1 }).catch(() => undefined);
      mark(build.releaseId, 'failed', { reason: reasonOf(err) });
    }
  }
  return progress;
}
