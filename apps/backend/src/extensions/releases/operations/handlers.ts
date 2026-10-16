import type { NodeRequest, StepResult } from '@koala/agent-engine/procedure';
import { idleOf, splitImage, type OdooRelease, type ReleaseState, type Slot, type SlotState } from '../../../lib/odoo-release.js';
import { marked, type ReleaseMark, type ReleaseRunInput, type ReplaceRunInput, type RollBackRunInput } from '../../../lib/release-run.js';
import type { ReleaseE2E } from '../../../lib/release-e2e.js';
import type { HostOperationRun } from '../../types.js';
import { adapterOf, type SlotAdapter, type SlotAdapters, type SlotBuild } from '../adapter.js';
import type { SlotCluster } from '../slot-cluster.js';
import { droppedCounts, snapshot } from '../postgres-compare.js';
import { itemChanges, newLosses, releaseChanges, schemaChanges, type ReleaseChanges } from '../../../lib/release-compare.js';
import { RELEASE_STATES_MARKED } from './declarations.js';

export interface BrowserTestsRequest {
  target: ReleaseRunInput['target'];
  source: ReleaseRunInput['build']['source'];
  ownerId: string;
  releaseId: string;
  slot: Slot;
  image: string;
}

export interface ReleaseOperationDeps {
  cluster: SlotCluster;
  adapters: SlotAdapters;
  releases: {
    list(ownerId: string, projectId: string): Promise<OdooRelease[]>;
    save(release: OdooRelease): Promise<void>;
  };
  browserTests?: ((request: BrowserTestsRequest) => Promise<ReleaseE2E>) | undefined;
  images?: ImageDeploys | undefined;
  now?: (() => string) | undefined;
}

export interface ImageDeploys {
  deploy(projectId: string, pipelineRunId: string): Promise<{ workflowId: string }>;
  settled(workflowId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

interface OpenRelease extends ReleaseRunInput {
  slot?: Slot | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const reasonOf = (err: unknown): string => {
  let reason = 'the release failed';
  for (let at = err as { message?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
    if (typeof at.message === 'string' && at.message) reason = at.message;
  }
  return reason;
};

function runInput(request: NodeRequest): ReleaseRunInput {
  const input = request.run.inputs as Partial<ReleaseRunInput>;
  if (!input.ownerId || !input.projectId || !input.adapter || !isRecord(input.target) || !isRecord(input.build) || !input.build.releaseId) {
    throw new Error('this run was not started for a release: its inputs have no release');
  }
  return input as ReleaseRunInput;
}

function releaseOf(request: NodeRequest): OpenRelease {
  const wired = request.inputs.release;
  return isRecord(wired) && isRecord(wired.build) ? wired as unknown as OpenRelease : runInput(request);
}

const buildOf = (release: ReleaseRunInput): SlotBuild => ({ image: release.build.image, source: release.build.source, ...(release.build.vault ? { vault: release.build.vault } : {}) });

const cleared = (state: SlotState, slot: Slot): SlotState => ({ ...state, tags: { ...state.tags, [slot]: undefined } });

export async function compareSlots(cluster: SlotCluster, adapter: SlotAdapter, target: ReleaseRunInput['target'], live: Slot, prepared: Slot, at: string): Promise<ReleaseChanges> {
  const liveDb = adapter.database(target, live);
  const diff = schemaChanges(await snapshot(cluster, target, liveDb), await snapshot(cluster, target, adapter.database(target, prepared)));
  const counts = await droppedCounts(cluster, target, liveDb, diff);
  const before = adapter.inventory ? await adapter.inventory(cluster, target, live) : [];
  const after = adapter.inventory && before.length ? await adapter.inventory(cluster, target, prepared, before) : [];
  return releaseChanges(diff, counts, itemChanges(before, after), at);
}

export function createReleaseOperations(deps: ReleaseOperationDeps): Record<string, HostOperationRun> {
  const now = deps.now ?? (() => new Date().toISOString());
  const { cluster } = deps;

  const mark = async (release: Pick<ReleaseRunInput, 'ownerId' | 'projectId'>, releaseId: string, how: ReleaseMark): Promise<OdooRelease | undefined> => {
    const changes = marked(await deps.releases.list(release.ownerId, release.projectId), releaseId, how, now());
    for (const change of changes) await deps.releases.save(change);
    return changes[0];
  };

  const recordOf = async (release: Pick<ReleaseRunInput, 'ownerId' | 'projectId'>, releaseId: string): Promise<OdooRelease | undefined> =>
    (await deps.releases.list(release.ownerId, release.projectId)).find((entry) => entry.id === releaseId);

  const apply = (adapter: SlotAdapter, release: ReleaseRunInput, state: SlotState, preview = false, build: ReleaseRunInput['build'] = release.build) =>
    cluster.apply(release.target, build.source, adapter.sets({ image: build.image, state, host: release.host, ...(preview ? { previewHost: release.previewHost } : {}) }));

  const vault = async (release: ReleaseRunInput) => {
    if (release.build.vault) await cluster.vault(release.target, release.build.vault, release.secretTarget);
  };

  const failed = (err: unknown): StepResult => ({ exit: 'failed', outputs: { reason: reasonOf(err) } });

  return {
    async 'releases.open'(request) {
      const release = runInput(request);
      if (!(await recordOf(release, release.build.releaseId))) return { exit: 'gone', outputs: { reason: 'the release is no longer recorded' } };
      adapterOf(deps.adapters, release.adapter);
      const state = await cluster.state(release.target);
      await mark(release, release.build.releaseId, { state: 'preparing' });
      const first = !state.installed || !state.tags[state.live];
      return { exit: first ? 'first' : 'beside', outputs: { release } };
    },

    async 'releases.install-first'(request) {
      const release = releaseOf(request);
      const adapter = adapterOf(deps.adapters, release.adapter);
      try {
        await mark(release, release.build.releaseId, { state: 'preparing', slot: 'a' });
        await vault(release);
        const empty: SlotState = { installed: true, live: 'a', tags: { a: undefined, b: undefined } };
        await apply(adapter, release, empty);
        await cluster.waitReady(release.target, adapter.dataStore(release.target));
        await adapter.init(cluster, release.target, 'a', buildOf(release));
        await apply(adapter, release, { ...empty, tags: { a: splitImage(release.build.image).tag, b: undefined } });
        await cluster.waitReady(release.target, adapter.workload(release.target, 'a'));
        return { exit: 'done', outputs: { release: { ...release, slot: 'a' } } };
      } catch (err) {
        return failed(err);
      }
    },

    async 'releases.prepare'(request) {
      const release = releaseOf(request);
      const adapter = adapterOf(deps.adapters, release.adapter);
      try {
        const current = await cluster.state(release.target);
        const idle = idleOf(current.live);
        await mark(release, release.build.releaseId, { state: 'preparing', slot: idle });
        await vault(release);
        await apply(adapter, release, cleared(current, idle));
        await adapter.copy(cluster, release.target, current.live, idle, buildOf(release));
        await adapter.quiet(cluster, release.target, idle);
        await adapter.upgrade(cluster, release.target, idle, buildOf(release));
        await apply(adapter, release, { ...current, tags: { ...current.tags, [idle]: splitImage(release.build.image).tag } }, true);
        await cluster.waitReady(release.target, adapter.workload(release.target, idle));
        return { exit: 'ready', outputs: { release: { ...release, slot: idle } } };
      } catch (err) {
        return failed(err);
      }
    },

    async 'releases.compare'(request) {
      const release = releaseOf(request);
      const adapter = adapterOf(deps.adapters, release.adapter);
      try {
        const current = await cluster.state(release.target);
        const prepared = release.slot ?? idleOf(current.live);
        const changes = await compareSlots(cluster, adapter, release.target, current.live, prepared, now());
        await mark(release, release.build.releaseId, { state: 'preparing', slot: prepared, changes });
        return { exit: 'done', outputs: { release: { ...release, slot: prepared }, changes, losing: changes.losing } };
      } catch (err) {
        return failed(err);
      }
    },

    async 'releases.browser-tests'(request) {
      const release = releaseOf(request);
      const slot = release.slot ?? (await recordOf(release, release.build.releaseId))?.slot;
      const startedAt = now();
      if (!deps.browserTests || !slot) {
        const report: ReleaseE2E = { state: 'unavailable', reason: deps.browserTests ? 'the release has no slot to test' : 'browser tests are not set up on this worker', startedAt, finishedAt: startedAt };
        await mark(release, release.build.releaseId, { state: 'preview', e2e: report });
        return { exit: 'done', outputs: { report } };
      }
      await mark(release, release.build.releaseId, { state: 'preview', e2e: { state: 'running', startedAt } });
      const report = await deps.browserTests({ target: release.target, source: release.build.source, ownerId: release.ownerId, releaseId: release.build.releaseId, slot, image: release.build.image })
        .catch((err: unknown): ReleaseE2E => ({ state: 'unavailable', reason: reasonOf(err), startedAt, finishedAt: now() }));
      await mark(release, release.build.releaseId, { state: 'preview', e2e: report });
      return { exit: 'done', outputs: { report } };
    },

    async 'releases.switch'(request) {
      const release = releaseOf(request);
      const adapter = adapterOf(deps.adapters, release.adapter);
      let maintenance: Slot | undefined;
      try {
        const current = await cluster.state(release.target);
        const idle = idleOf(current.live);
        const ready: SlotState = { ...current, tags: { ...current.tags, [idle]: splitImage(release.build.image).tag } };
        maintenance = current.live;
        await cluster.scale(release.target, adapter.workload(release.target, current.live), 0);
        await apply(adapter, release, cleared(current, idle));
        await adapter.copy(cluster, release.target, current.live, idle, buildOf(release));
        await adapter.upgrade(cluster, release.target, idle, buildOf(release));
        const shown = (await recordOf(release, release.build.releaseId))?.changes;
        const appeared = newLosses(shown, await compareSlots(cluster, adapter, release.target, current.live, idle, now()));
        if (appeared.length) throw new Error(`the cut-over was stopped, because the final copy would also lose what the preview did not show: ${appeared.join('; ')}. The live slot serves again; push again to prepare a new preview`);
        await apply(adapter, release, { ...ready, live: idle });
        maintenance = undefined;
        await cluster.scale(release.target, adapter.workload(release.target, current.live), 0);
        await cluster.waitReady(release.target, adapter.workload(release.target, idle));
        return { exit: 'done', outputs: { release: { ...release, slot: idle } } };
      } catch (err) {
        if (maintenance) await cluster.scale(release.target, adapter.workload(release.target, maintenance), 1).catch(() => undefined);
        return failed(err);
      }
    },

    async 'releases.clear'(request) {
      const release = releaseOf(request);
      const adapter = adapterOf(deps.adapters, release.adapter);
      try {
        const current = await cluster.state(release.target);
        await apply(adapter, release, cleared(current, idleOf(current.live)));
        return { exit: 'done', outputs: {} };
      } catch (err) {
        return failed(err);
      }
    },

    async 'releases.mark'(request) {
      const release = releaseOf(request);
      const state = request.node.settings.state as ReleaseState;
      if (!(RELEASE_STATES_MARKED as readonly string[]).includes(state)) throw new Error(`Mark Release cannot mark a release ${String(state)}`);
      const reason = typeof request.inputs.reason === 'string' && request.inputs.reason ? request.inputs.reason : undefined;
      await mark(release, release.build.releaseId, { state, ...(release.slot ? { slot: release.slot } : {}), ...(reason ? { reason } : {}) });
      return { exit: 'done', outputs: {} };
    },

    async 'releases.stopped'(request) {
      const release = runInput(request);
      const record = await recordOf(release, release.build.releaseId);
      if (!record) return { exit: 'done', outputs: {} };
      const adapter = adapterOf(deps.adapters, release.adapter);
      if (record.state === 'preview') {
        const current = await cluster.state(release.target);
        await apply(adapter, release, cleared(current, idleOf(current.live))).catch(() => undefined);
        await mark(release, record.id, { state: 'superseded', reason: 'a newer build took its place' });
      } else if (record.state === 'preparing' || record.state === 'queued') {
        await mark(release, record.id, { state: 'failed', reason: 'the release was stopped before it was ready' });
      } else if (record.state === 'cutting-over') {
        const current = await cluster.state(release.target).catch(() => undefined);
        if (current) await cluster.scale(release.target, adapter.workload(release.target, current.live), 1).catch(() => undefined);
        await mark(release, record.id, { state: 'failed', reason: 'the cut-over was stopped; the slot that was live serves again' });
      }
      return { exit: 'done', outputs: {} };
    },

    async 'releases.deploy-image'(request) {
      const input = request.run.inputs as Partial<ReplaceRunInput>;
      if (!input.projectId || !input.pipelineRunId) throw new Error('this run was not started for a build to deploy');
      if (!deps.images) throw new Error('image deploys are not set up on this worker');
      try {
        const { workflowId } = await deps.images.deploy(input.projectId, input.pipelineRunId);
        const settled = await deps.images.settled(workflowId);
        return settled.ok ? { exit: 'done', outputs: {} } : { exit: 'failed', outputs: { reason: settled.reason } };
      } catch (err) {
        return failed(err);
      }
    },

    async 'releases.roll-back'(request) {
      const input = request.run.inputs as Partial<RollBackRunInput>;
      if (!input.ownerId || !input.projectId || !input.from || !isRecord(input.to) || !input.adapter || !isRecord(input.target)) throw new Error('this run was not started for a roll back');
      const release = input as RollBackRunInput;
      const adapter = adapterOf(deps.adapters, release.adapter);
      const asRun: ReleaseRunInput = { ...release, build: release.to };
      let started: Slot | undefined;
      await mark(release, release.from, { state: 'rolling-back' });
      try {
        const current = await cluster.state(release.target);
        const kept = idleOf(current.live);
        if (current.tags[kept] !== splitImage(release.to.image).tag) throw new Error(`slot ${kept} no longer holds the release of ${release.to.source.commit.slice(0, 8)}`);
        started = kept;
        await cluster.scale(release.target, adapter.workload(release.target, kept), 1);
        await cluster.waitReady(release.target, adapter.workload(release.target, kept));
        await apply(adapter, asRun, { ...current, live: kept, tags: { ...current.tags, [current.live]: undefined } });
        started = undefined;
        await cluster.waitReady(release.target, adapter.workload(release.target, kept));
        await mark(release, release.to.releaseId, { state: 'live', slot: kept, restoredAt: now() });
        await mark(release, release.from, { state: 'rolled-back', reason: `rolled back to the release of ${release.to.source.commit.slice(0, 8)}` });
        return { exit: 'done', outputs: {} };
      } catch (err) {
        if (started) await cluster.scale(release.target, adapter.workload(release.target, started), 0).catch(() => undefined);
        await mark(release, release.from, { state: 'live', reason: `the rollback failed: ${reasonOf(err)}` });
        return failed(err);
      }
    },
  };
}
