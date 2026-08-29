
const SENTINEL = 'KOALA_MERGE';

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

export function buildMergeCompleteScript(): string {
  return [
    'cd /work/repo',
    `if [ -n "$(git diff --name-only --diff-filter=U)" ]; then echo "${SENTINEL}=conflict"; exit 0; fi`,
    `if [ -f .git/MERGE_HEAD ]; then echo "${SENTINEL}=uncommitted"; exit 0; fi`,
    `echo "${SENTINEL}=clean"`,
  ].join('\n');
}

export interface LandingMergeState {
  outcome: 'clean' | 'conflict' | 'skipped' | 'uncommitted' | 'unknown';
  branch?: string;
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
    .filter((l) => l && !l.includes(' ') && !l.startsWith(SENTINEL));

  return { outcome: 'conflict', ...(conflict[1] ? { branch: conflict[1] } : {}), files };
}

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
