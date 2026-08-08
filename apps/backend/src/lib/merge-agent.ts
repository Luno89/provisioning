/**
 * Resolving a merge the API refused, by handing the conflict to an agent.
 *
 * ── WHY THIS IS NOT LEFT TO A PERSON ──
 * The landing sweep merges verified work into the default branch and reports a conflict rather than
 * forcing one, which is correct — two leaves that edited the same file genuinely disagree and no
 * mechanical rule picks the right winner. But "correct" left a pull request open in Gitea, a log
 * line in a worker nobody reads, and a leaf marked `verified: true, merged: false`. The work was
 * finished, checked, and stranded on a manual step.
 *
 * Resolving a conflict is exactly the kind of thing the agent is already trusted to do inside a
 * leaf: read the two versions, understand both intents, write a file that serves both, run the
 * tests. The only reason it was not doing it here is that nobody had put it in the loop.
 *
 * ── THE SAFETY IS THE SAME AS EVERYWHERE ELSE ──
 * The resolution is verified before it lands. A merge the agent "fixed" into something that does
 * not build is worse than a conflict left alone, because a conflict is visible and a quietly broken
 * default branch is not. If the tests do not pass afterwards, nothing is pushed and the pull
 * request stays exactly where it was.
 */

/** Marks the merge attempt's verdict so the caller can read it out of interleaved git output. */
const SENTINEL = 'KOALA_MERGE';

/**
 * Positions a clean landing branch. Run ONCE per attempt, never between resolutions.
 *
 * Splitting this from the merge is not tidiness — it is the whole correctness of the loop. A single
 * script that reset the branch and re-merged on every round threw away the resolution the agent had
 * just committed and handed it the identical conflict again. Observed live: three rounds, three
 * identical conflicts on README.md, three agent runs, no progress.
 */
export function buildLandingSetupScript(defaultBranch: string): string {
  return [
    'set -e',
    'cd /work/repo',
    'git config user.email koala@local',
    'git config user.name Koala',
    'git fetch --quiet origin || true',
    `git checkout -B landing "origin/${defaultBranch}"`,
  ].join('\n');
}

/**
 * Merges ONE branch into whatever is currently checked out.
 *
 * A conflict leaves the worktree conflicted on purpose: that state is what the agent needs to look
 * at, and aborting would hand it a clean tree and a description of a problem it cannot see.
 */
export function buildMergeOneScript(branch: string): string {
  if (!/^koala\/[a-f0-9]{8}$/.test(branch)) return `echo "${SENTINEL}=skipped"`;

  return [
    'cd /work/repo',
    `if ! git rev-parse --verify --quiet "origin/${branch}" >/dev/null; then echo "${SENTINEL}=skipped"; exit 0; fi`,
    `if git merge --no-edit "origin/${branch}" >/dev/null 2>&1; then echo "${SENTINEL}=clean"; exit 0; fi`,
    `echo "${SENTINEL}=conflict branch=${branch}"`,
    'git diff --name-only --diff-filter=U',
  ].join('\n');
}

/**
 * Whether the agent actually finished the merge it was handed.
 *
 * Asked of git, not of the agent. A run that reports success having left conflict markers in place,
 * or having stopped short of committing, would otherwise be taken at its word and pushed.
 */
export function buildMergeCompleteScript(): string {
  return [
    'cd /work/repo',
    `if [ -n "$(git diff --name-only --diff-filter=U)" ]; then echo "${SENTINEL}=conflict"; exit 0; fi`,
    // MERGE_HEAD surviving means the merge was resolved but never committed.
    `if [ -f .git/MERGE_HEAD ]; then echo "${SENTINEL}=uncommitted"; exit 0; fi`,
    `echo "${SENTINEL}=clean"`,
  ].join('\n');
}

export interface LandingMergeState {
  outcome: 'clean' | 'conflict' | 'skipped' | 'uncommitted' | 'unknown';
  /** The branch that could not be merged, when there was one. */
  branch?: string;
  /** Paths left with conflict markers, for the agent's task description. */
  files: string[];
}

export function parseLandingMerge(stdout: string): LandingMergeState {
  if (new RegExp(`${SENTINEL}=clean`).test(stdout)) return { outcome: 'clean', files: [] };
  if (new RegExp(`${SENTINEL}=skipped`).test(stdout)) return { outcome: 'skipped', files: [] };
  if (new RegExp(`${SENTINEL}=uncommitted`).test(stdout)) return { outcome: 'uncommitted', files: [] };

  const conflict = new RegExp(`${SENTINEL}=conflict branch=(\\S+)`).exec(stdout);
  if (!conflict) return { outcome: 'unknown', files: [] };

  const files = stdout
    .slice(conflict.index + conflict[0].length)
    .split('\n')
    .map((l) => l.trim())
    // Paths only — git prints nothing else here, but the agent's task should not carry stray output.
    .filter((l) => l && !l.includes(' ') && !l.startsWith(SENTINEL));

  return { outcome: 'conflict', ...(conflict[1] ? { branch: conflict[1] } : {}), files };
}

/**
 * What the resolving agent is told.
 *
 * Deliberately narrow. This agent is not finishing the feature or improving anything it reads — it
 * is reconciling two changes that were each already verified on their own. Widening the brief is
 * how a merge turns into a rewrite, and the tests it has to satisfy belong to both sides.
 */
export function buildMergeTask(branch: string, files: string[]): string {
  return [
    `Two pieces of work were completed separately and both passed their own tests. Merging "${branch}"`,
    'into the default branch left conflicts that need resolving.',
    '',
    files.length
      ? `Files with conflict markers:\n${files.map((f) => `  - ${f}`).join('\n')}`
      : 'Run `git diff --name-only --diff-filter=U` to see which files conflict.',
    '',
    'The repository is at /work/repo, mid-merge, with the conflicts in the working tree.',
    '',
    'What to do:',
    '- Resolve every conflict so that BOTH sides\' intent survives. Neither side is more correct;',
    '  they are two features that were built in parallel.',
    '- Do not delete a passing test, and do not weaken one to make it pass.',
    '- Do not add features, refactor, or tidy anything unrelated to the conflict.',
    '- Run the full test suite. Every test from both sides must pass.',
    '- `git add` the resolved files and commit the merge. Do not push — that is handled for you.',
  ].join('\n');
}
