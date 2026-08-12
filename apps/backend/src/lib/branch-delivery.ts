/**
 * What happened to a request, end to end, as a chain of stages.
 *
 * ── WHY THE BRANCH AND NOT THE PROJECT ──
 * A project rollup answers "is this repo's code running". For agent work the unit people actually
 * care about is the REQUEST — what they asked for, and how far it got. Those are different
 * questions: one request can leave leaves unmerged, or land its code and fail its acceptance
 * checks, and the project would still read `running`.
 *
 * ── WHY A CHAIN AND NOT ONE WORD ──
 * The Projects list wants one word, because it is a list. A branch is the thing you opened to find
 * out what went wrong, and there the useful answer is WHERE it stopped: work that failed, work that
 * never merged, an image that never built, a pod that will not start, and checks that did not pass
 * are five different problems with five different fixes. Collapsing them is what made the platform
 * something you had to read the database to understand.
 *
 * Every stage here is derived from records this platform already writes. Nothing reads git.
 */
import type { Branch, Leaf } from './leaves.js';
import { usableAcceptancePlan } from './acceptance.js';
import type { ProjectStatus } from './project-status.js';

export type StageState =
  /** Not reached yet — nothing has gone wrong. */
  | 'pending'
  | 'active'
  | 'done'
  /** Reached and broken. */
  | 'failed'
  /** Reached, landed, and not working — the deploy equivalent of `unhealthy`. */
  | 'warn'
  /** Deliberately not applicable to this request, e.g. research with nothing to deploy. */
  | 'skipped';

export interface DeliveryStage {
  key: 'work' | 'landed' | 'built' | 'deployed' | 'accepted';
  label: string;
  state: StageState;
  /** One short phrase. Shown next to the stage, so it must stand alone. */
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
        // Verified is called out separately from succeeded: a leaf can report success without
        // anything having checked it, and that distinction is the whole point of the evidence row.
        : { key: 'work', label: 'Work', state: 'done', detail: `${verified} of ${mine.length} verified` };

  const landed: DeliveryStage = !succeeded.length
    ? { key: 'landed', label: 'Landed', state: 'pending', detail: 'nothing to merge yet' }
    : merged >= succeeded.length
      ? { key: 'landed', label: 'Landed', state: 'done', detail: `${merged} merged to main` }
      : { key: 'landed', label: 'Landed', state: merged ? 'active' : 'pending', detail: `${merged} of ${succeeded.length} merged` };

  /**
   * Build and deploy come from the project rollup, so a branch and the Projects list can never
   * disagree. Absent when the request never produced a project — a chat that proposed nothing.
   */
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
      // Not a failure. Plenty of requests produce something that is never meant to be a service.
      ? { key: 'deployed', label: 'Deployed', state: 'skipped', detail: 'not deployed' }
      : project.status === 'deploying'
        ? { key: 'deployed', label: 'Deployed', state: 'active', detail: 'deploying' }
        : project.status === 'deploy-failed'
          ? { key: 'deployed', label: 'Deployed', state: 'failed', detail: 'the deploy did not complete' }
          : project.status === 'unhealthy'
            ? { key: 'deployed', label: 'Deployed', state: 'warn', detail: project.reason || 'deployed, not running' }
            : { key: 'deployed', label: 'Deployed', state: 'done', detail: 'running' };

  const plan = usableAcceptancePlan(branch.acceptance);
  const accepted: DeliveryStage = !plan.length
    ? { key: 'accepted', label: 'Accepted', state: 'skipped', detail: 'no checks declared' }
    : !branch.acceptanceRunAt
      ? { key: 'accepted', label: 'Accepted', state: 'pending', detail: `${plan.length} check${plan.length === 1 ? '' : 's'} waiting` }
      : branch.acceptanceOutcome === 'failed'
        ? { key: 'accepted', label: 'Accepted', state: 'failed', detail: branch.acceptanceFailedCheck ? `failed at "${branch.acceptanceFailedCheck}"` : 'a check failed' }
        : branch.acceptanceOutcome === 'passed'
          ? { key: 'accepted', label: 'Accepted', state: 'done', detail: `${plan.length} check${plan.length === 1 ? '' : 's'} passed` }
          /**
           * Ran, and we cannot say it passed. Never `done`: "nobody knows" is worse than a known
           * failure and must not render as a pass.
           *
           * The two ways to get here are worth distinguishing. `unknown` means the check itself
           * produced no verdict this run. An ABSENT outcome means the run predates this field —
           * a fact about the schema, not about the work — and saying "ran without a verdict"
           * there would blame the request for a gap in what was recorded.
           */
          : {
              key: 'accepted',
              label: 'Accepted',
              state: 'warn',
              detail: branch.acceptanceOutcome === 'unknown' ? 'ran without a verdict' : 'verdict not recorded',
            };

  return [work, landed, built, deployed, accepted];
}
