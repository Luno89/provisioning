import type { ImportMode } from './client-import.js';
import type { SecretTarget } from './infisical-sync.js';
import type { OdooRelease, ReleaseState, ReleaseVault, Slot } from './odoo-release.js';
import type { ReleaseE2E } from './release-e2e.js';
import type { ReleaseChanges } from './release-compare.js';

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
  restore?: { mode: ImportMode } | undefined;
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
export const REPLACE_AGENT = 'release-replace';
export const REPLACE_PROCEDURE = 'replace';
export const CUT_OVER = 'Cut over';
export const DISCARD = 'Discard';
export const RETEST = 'Run tests again';
export const DECISION_NODE = 'decide';
export const CUT_OVER_LOSING = 'Cut over, losing what is listed';
export const LOSING_DECISION_NODE = 'decideLosing';
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
  changes?: ReleaseChanges | undefined;
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
    ...(mark.changes ? { changes: mark.changes } : {}),
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

export interface ReleaseHow {
  agent: string;
  app?: string | undefined;
}

export interface ReplaceRunInput {
  ownerId: string;
  projectId: string;
  pipelineRunId: string;
}

export const replaceRunId = (projectId: string, pipelineRunId: string, stamp: string): string => `release-${projectId}-${pipelineRunId}~${stamp}`;

export function releaseHowOf(project: { release?: ReleaseHow | undefined }, type: { release?: ReleaseHow | undefined } | undefined, hasChart: boolean): ReleaseHow {
  if (project.release?.agent) return project.release;
  if (type?.release?.agent) return type.release;
  return hasChart ? { agent: RELEASE_AGENT, app: DEFAULT_RELEASE_APP } : { agent: REPLACE_AGENT };
}

export function releaseHowProblem(value: unknown): string | null {
  if (value === undefined) return null;
  const how = value as Partial<ReleaseHow> | null;
  if (!how || typeof how !== 'object') return 'release must be { agent, app }';
  if (typeof how.agent !== 'string' || !how.agent.trim()) return 'release must name the agent that releases a build';
  if (how.app !== undefined && (typeof how.app !== 'string' || !how.app.trim())) return 'release.app names the app adapter (like odoo)';
  return null;
}

export interface ReleaseApp {
  id: string;
  restores?: boolean | undefined;
  title: string;
}

export const RELEASE_APPS: readonly ReleaseApp[] = [{ id: 'odoo', title: 'Odoo', restores: true }];

export const restoringApp = (app: string): { title: string } | undefined => {
  const found = RELEASE_APPS.find((entry) => entry.id === app && entry.restores);
  return found ? { title: found.title } : undefined;
};

export const RELEASE_STEP = 'releases.';
export const IMAGE_ONLY_STEPS: readonly string[] = ['releases.deploy-image'];
export const OPEN_STEP = 'releases.open';
