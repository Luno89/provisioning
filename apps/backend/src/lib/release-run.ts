import type { SecretTarget } from './infisical-sync.js';
import type { OdooRelease, ReleaseState, ReleaseVault, Slot } from './odoo-release.js';
import type { ReleaseE2E } from './release-e2e.js';

export interface ReleaseTarget {
  clusterName: string;
  provider: string;
  gpuEnabled?: boolean | undefined;
  kubeconfigPath?: string | undefined;
  namespace: string;
  release: string;
  owner?: { ownerId: string; projectId: string } | undefined;
}

export interface ReleaseSource {
  owner: string;
  repo: string;
  commit: string;
}

export interface ReleaseBuildInput {
  releaseId: string;
  image: string;
  source: ReleaseSource;
  vault?: ReleaseVault | undefined;
}

export interface ReleaseRunInput {
  ownerId: string;
  projectId: string;
  adapter: string;
  target: ReleaseTarget;
  host: string;
  previewHost: string;
  secretTarget: SecretTarget;
  build: ReleaseBuildInput;
}

export interface RollBackRunInput extends Omit<ReleaseRunInput, 'build'> {
  from: string;
  to: ReleaseBuildInput;
}

export const RELEASE_PROCEDURE = 'slots';
export const ROLL_BACK_PROCEDURE = 'slots-roll-back';
export const RELEASE_AGENT = 'release';
export const ROLL_BACK_AGENT = 'release-roll-back';
export const CUT_OVER = 'Cut over';
export const DISCARD = 'Discard';
export const RETEST = 'Run tests again';
export const DECISION_NODE = 'decide';
export const DEFAULT_RELEASE_APP = 'odoo';

export const releaseRunWorkflowId = (projectId: string): string => `release-${projectId}`;
export const releaseRunId = (projectId: string, stamp: string): string => `${releaseRunWorkflowId(projectId)}~${stamp}`;

export const UNSETTLED_STATES: readonly ReleaseState[] = ['queued', 'preparing', 'preview', 'cutting-over', 'rolling-back'];
export const FINAL_STATES: readonly ReleaseState[] = ['superseded', 'rolled-back', 'discarded', 'failed'];

export interface ReleaseMark {
  state: ReleaseState;
  slot?: Slot | undefined;
  reason?: string | undefined;
  e2e?: ReleaseE2E | undefined;
  restoredAt?: string | undefined;
}

export function marked(releases: readonly OdooRelease[], releaseId: string, mark: ReleaseMark, now: string): OdooRelease[] {
  const release = releases.find((entry) => entry.id === releaseId);
  if (!release) return [];
  const restored = mark.state === 'live' && Boolean(mark.restoredAt);
  const { replacedBy: _replacedBy, reason: _reason, ...kept } = release;
  const updated: OdooRelease = {
    ...(restored ? kept : release),
    state: mark.state,
    ...(mark.slot ? { slot: mark.slot } : {}),
    ...(mark.reason ? { reason: mark.reason } : {}),
    ...(mark.e2e ? { e2e: mark.e2e } : {}),
    ...(mark.state === 'live' && release.state !== 'live' ? { liveAt: now } : {}),
    ...(restored ? { restoredAt: mark.restoredAt } : {}),
    updatedAt: now,
  };
  const changes = [updated];
  if (mark.state === 'live' && !restored) {
    for (const earlier of releases.filter((other) => other.id !== release.id && other.projectId === release.projectId && other.state === 'live' && other.startedAt <= release.startedAt)) {
      changes.push({ ...earlier, state: 'superseded', reason: `replaced by the release of ${release.commit.slice(0, 8)}`, replacedBy: release.id, updatedAt: now });
    }
  }
  return changes;
}
