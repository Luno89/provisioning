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
  key: 'work' | 'answered' | 'landed' | 'built' | 'deployed' | 'accepted';
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

  /**
   * Answer-shaped work is excluded from everything downstream of the work itself.
   *
   * Recognised by what a leaf PRODUCED — an answer on the record and no branch — rather than by a
   * label saying what it was meant to be. The label was a second description of the same fact, and
   * the fact is the one that cannot be wrong. Counting these would leave a request that behaved
   * correctly permanently showing "0 of 1 merged" against work that was never going to merge.
   */
  const isAnswer = (l: Leaf) => Boolean(l.findings?.trim()) && !l.outputBranch;
  const buildable = succeeded.filter((l) => !isAnswer(l));
  const allResearch = mine.length > 0 && mine.every(isAnswer);

  const landed: DeliveryStage = !buildable.length
      ? { key: 'landed', label: 'Landed', state: 'pending', detail: 'nothing to merge yet' }
      : merged >= buildable.length
        ? { key: 'landed', label: 'Landed', state: 'done', detail: `${merged} merged to main` }
        : { key: 'landed', label: 'Landed', state: merged ? 'active' : 'pending', detail: `${merged} of ${buildable.length} merged` };

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

  /**
   * The research equivalent of Landed: the answer exists and is stored.
   *
   * `findings` rather than `verified`, because this stage is about the deliverable being THERE.
   * Whether it was any good is what the Work stage's verified count already reports.
   */
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

  /**
   * A research request gets a SHORTER chain, not five stages with three struck through.
   *
   * Landed, Built and Deployed are not steps a research request skipped — they are steps it never
   * had. Rendering them greyed out says "three things did not happen here" about work that was
   * never going to do them, and it buries the one stage that matters. Composition decides the
   * shape: the moment a request contains anything that produces code, the build chain is real and
   * comes back.
   */
  if (allResearch) return [work, answered, accepted];
  return [work, landed, built, deployed, accepted];
}
