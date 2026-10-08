import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { OdooReleaseActivities, ReleaseSource, ReleaseTarget } from '../activities/OdooReleaseActivities.js';
import { databaseOf, filestoreJob, helmSets, idleOf, odooJob, splitImage, type ReleaseState, type Slot, type SlotState } from '../lib/odoo-release.js';

export interface ReleaseBuild {
  releaseId: string;
  image: string;
  source: ReleaseSource;
}

export interface OdooReleaseInput {
  target: ReleaseTarget;
  host: string;
  previewHost: string;
}

export interface ReleaseProgress {
  state: ReleaseState;
  slot?: Slot | undefined;
  reason?: string | undefined;
}

export const releaseBuildSignal = defineSignal<[ReleaseBuild]>('releaseBuild');
export const cutOverSignal = defineSignal<[string]>('cutOver');
export const discardSignal = defineSignal<[string]>('discard');
export const releasesQuery = defineQuery<Record<string, ReleaseProgress>>('releases');

const quick = proxyActivities<Pick<OdooReleaseActivities, 'OdooReleaseStateActivity' | 'OdooReleaseModulesActivity' | 'OdooReleaseApplyActivity' | 'OdooReleaseInstalledActivity' | 'OdooReleaseScaleActivity' | 'OdooReleaseCopyDatabaseActivity'>>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 3 },
});

const long = proxyActivities<Pick<OdooReleaseActivities, 'OdooReleaseWaitActivity' | 'OdooReleaseJobActivity'>>({
  startToCloseTimeout: '45 minutes',
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

  setHandler(releaseBuildSignal, (build) => { pending.push(build); });
  setHandler(cutOverSignal, (releaseId) => { if (!decisions.has(releaseId)) decisions.set(releaseId, 'cutOver'); });
  setHandler(discardSignal, (releaseId) => { if (!decisions.has(releaseId)) decisions.set(releaseId, 'discard'); });
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

  const prepare = async (build: ReleaseBuild, slot: Slot, from: Slot, modules: string[]) => {
    await quick.OdooReleaseCopyDatabaseActivity({ target, from: databaseOf(from), to: databaseOf(slot) });
    await job('filestore', slot, filestoreJob({ name: '', release: target.release, image: build.image, from: databaseOf(from), to: databaseOf(slot) }));
    const installed = new Set(await quick.OdooReleaseInstalledActivity({ target, database: databaseOf(slot) }));
    await job('upgrade', slot, odooJob({
      name: '',
      release: target.release,
      image: build.image,
      database: databaseOf(slot),
      install: modules.filter((module) => !installed.has(module)),
      update: modules.filter((module) => installed.has(module)),
    }));
  };

  await condition(() => pending.length > 0, '1 minute');
  while (pending.length > 0) {
    const build = pending.shift()!;
    mark(build.releaseId, 'preparing');
    let maintenance: Slot | undefined;
    try {
      const current = await quick.OdooReleaseStateActivity(target);
      const tag = splitImage(build.image).tag;
      const modules = await quick.OdooReleaseModulesActivity(build.source);

      if (!current.installed || !current.tags[current.live]) {
        const empty: SlotState = { installed: true, live: 'a', tags: { a: undefined, b: undefined } };
        mark(build.releaseId, 'preparing', { slot: 'a' });
        await apply(build, empty);
        await long.OdooReleaseWaitActivity({ target, workload: `statefulset/${target.release}-postgres`, timeoutMs: POSTGRES_READY_MS });
        await job('init', 'a', odooJob({ name: '', release: target.release, image: build.image, database: databaseOf('a'), install: ['base', ...modules], update: [] }));
        await apply(build, { ...empty, tags: { a: tag, b: undefined } });
        await slotReady('a');
        mark(build.releaseId, 'live', { slot: 'a' });
        continue;
      }

      const idle = idleOf(current.live);
      const cleared: SlotState = { ...current, tags: { ...current.tags, [idle]: undefined } };
      mark(build.releaseId, 'preparing', { slot: idle });
      await apply(build, cleared);
      await prepare(build, idle, current.live, modules);
      const ready: SlotState = { ...cleared, tags: { ...cleared.tags, [idle]: tag } };
      await apply(build, ready, input.previewHost);
      await slotReady(idle);
      mark(build.releaseId, 'preview', { slot: idle });

      await condition(() => decisions.has(build.releaseId) || pending.length > 0);
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
      await prepare(build, idle, current.live, modules);
      await apply(build, { ...ready, live: idle });
      maintenance = undefined;
      await slotReady(idle);
      mark(build.releaseId, 'live', { slot: idle });
    } catch (err) {
      if (maintenance) await quick.OdooReleaseScaleActivity({ target, slot: maintenance, replicas: 1 }).catch(() => undefined);
      mark(build.releaseId, 'failed', { reason: reasonOf(err) });
    }
  }
  return progress;
}
