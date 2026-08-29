import type { Branch, Leaf } from './leaves.js';
import { usableAcceptancePlan } from './acceptance.js';
import type { ProjectStatus } from './project-status.js';

export type StageState =
  | 'pending'
  | 'active'
  | 'done'
  | 'failed'
  | 'warn'
  | 'skipped';

export interface DeliveryStage {
  key: 'work' | 'answered' | 'landed' | 'built' | 'deployed' | 'accepted';
  label: string;
  state: StageState;
  detail: string;
}

const FINISHED = new Set(['succeeded', 'failed', 'cancelled']);

export function summariseDelivery(
  branch: Pick<Branch, 'id' | 'acceptance' | 'acceptanceRunAt' | 'acceptanceOutcome' | 'acceptanceFailedCheck'>,
  leaves: Leaf[],
  project: { status: ProjectStatus; reason: string } | undefined,
): DeliveryStage[] {
  const mine = leaves.filter((l) => l.branchId === branch.id && l.status !== 'proposed');
  const succeeded = mine.filter((l) => l.status === 'succeeded');
  const failed = mine.filter((l) => l.status === 'failed');
  const inFlight = mine.filter((l) => !FINISHED.has(l.status));
  const verified = succeeded.filter((l) => l.verified).length;
  const merged = mine.filter((l) => l.merged).length;

  const work: DeliveryStage = !mine.length
    ? { key: 'work', label: 'Work', state: 'pending', detail: 'nothing accepted yet' }
    : inFlight.length
      ? { key: 'work', label: 'Work', state: 'active', detail: `${succeeded.length + failed.length} of ${mine.length} finished` }
      : failed.length
        ? { key: 'work', label: 'Work', state: 'failed', detail: `${failed.length} of ${mine.length} failed` }
        : { key: 'work', label: 'Work', state: 'done', detail: `${verified} of ${mine.length} verified` };

  const isAnswer = (l: Leaf) => Boolean(l.findings?.trim()) && !l.outputBranch;
  const buildable = succeeded.filter((l) => !isAnswer(l));
  const allResearch = mine.length > 0 && mine.every(isAnswer);

  const landed: DeliveryStage = !buildable.length
      ? { key: 'landed', label: 'Landed', state: 'pending', detail: 'nothing to merge yet' }
      : merged >= buildable.length
        ? { key: 'landed', label: 'Landed', state: 'done', detail: `${merged} merged to main` }
        : { key: 'landed', label: 'Landed', state: merged ? 'active' : 'pending', detail: `${merged} of ${buildable.length} merged` };

  const built: DeliveryStage = !project
    ? { key: 'built', label: 'Built', state: 'pending', detail: 'no project yet' }
    : project.status === 'no-build'
      ? { key: 'built', label: 'Built', state: 'pending', detail: 'no build has run' }
      : project.status === 'building'
        ? { key: 'built', label: 'Built', state: 'active', detail: 'building' }
        : project.status === 'build-failed'
          ? { key: 'built', label: 'Built', state: 'failed', detail: project.reason || 'the build failed' }
          : { key: 'built', label: 'Built', state: 'done', detail: 'image ready' };

  const deployed: DeliveryStage = !project || project.status === 'no-build' || project.status === 'building' || project.status === 'build-failed'
    ? { key: 'deployed', label: 'Deployed', state: 'pending', detail: 'nothing to deploy yet' }
    : project.status === 'built'
      ? { key: 'deployed', label: 'Deployed', state: 'skipped', detail: 'not deployed' }
      : project.status === 'deploying'
        ? { key: 'deployed', label: 'Deployed', state: 'active', detail: 'deploying' }
        : project.status === 'deploy-failed'
          ? { key: 'deployed', label: 'Deployed', state: 'failed', detail: 'the deploy did not complete' }
          : project.status === 'unhealthy'
            ? { key: 'deployed', label: 'Deployed', state: 'warn', detail: project.reason || 'deployed, not running' }
            : { key: 'deployed', label: 'Deployed', state: 'done', detail: 'running' };

  const research = mine.filter(isAnswer);
  const answeredCount = research.length;
  const answered: DeliveryStage = !research.length
    ? { key: 'answered', label: 'Answered', state: 'pending', detail: 'no answer yet' }
    : answeredCount >= research.length
      ? { key: 'answered', label: 'Answered', state: 'done', detail: answeredCount === 1 ? 'answer written' : `${answeredCount} answers written` }
      : { key: 'answered', label: 'Answered', state: answeredCount ? 'active' : 'pending', detail: `${answeredCount} of ${research.length} written` };

  const plan = usableAcceptancePlan(branch.acceptance);
  const accepted: DeliveryStage = !plan.length
    ? { key: 'accepted', label: 'Accepted', state: 'skipped', detail: 'no checks declared' }
    : !branch.acceptanceRunAt
      ? { key: 'accepted', label: 'Accepted', state: 'pending', detail: `${plan.length} check${plan.length === 1 ? '' : 's'} waiting` }
      : branch.acceptanceOutcome === 'failed'
        ? { key: 'accepted', label: 'Accepted', state: 'failed', detail: branch.acceptanceFailedCheck ? `failed at "${branch.acceptanceFailedCheck}"` : 'a check failed' }
        : branch.acceptanceOutcome === 'passed'
          ? { key: 'accepted', label: 'Accepted', state: 'done', detail: `${plan.length} check${plan.length === 1 ? '' : 's'} passed` }
          : {
              key: 'accepted',
              label: 'Accepted',
              state: 'warn',
              detail: branch.acceptanceOutcome === 'unknown' ? 'ran without a verdict' : 'verdict not recorded',
            };

  if (allResearch) return [work, answered, accepted];
  return [work, landed, built, deployed, accepted];
}
