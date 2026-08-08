/**
 * Where a leaf's sandbox starts from, and what it leaves behind for the leaves that follow it.
 *
 * ── THE FAILURE ──
 * `dependsOn` orders work; it never moved any. A dependent leaf woke in a sandbox that had no
 * trace of what its dependency built. Measured live twice: five leaves fanned out from "Create
 * base GitHub API client", which succeeded for 45,488 tokens and had its sandbox destroyed, and
 * the four dependents each spent their entire step budget rebuilding it from nothing. Then again
 * on a three-leaf plan, where leaf 1 wrote `index.js`, its pod terminated, and the leaf that was
 * supposed to test it failed after 24,880 tokens with nothing to test.
 *
 * There were two independent holes, and fixing either alone still loses the work:
 *
 *   1. A leaf with no `projectId` had no repository at all, so nothing outlived the pod.
 *   2. A leaf WITH one cloned the repository's default branch and cut a fresh branch from it —
 *      so even a leaf whose dependency had pushed perfectly good work started without it.
 *
 * ── THE SHAPE OF THE FIX ──
 * Every leaf gets a repository (auto-provisioned per request when none was chosen), and a leaf
 * starts from its dependencies' branches rather than from the default one. The chain of branches
 * is the hand-off: leaf 2 branches from leaf 1's output, so its clone already contains leaf 1's
 * commits.
 *
 * The script is built here rather than inline in the activity because the script IS the bug — the
 * old one was three lines that looked obviously correct and silently discarded every dependency.
 */
import type { Leaf } from './leaves.js';

export const LEAF_BRANCH_PREFIX = 'koala/';

/** Deterministic from the leaf id, so a retry pushes to the same branch instead of forking one. */
export function branchNameFor(leafId: string): string {
  return `${LEAF_BRANCH_PREFIX}${leafId.slice(0, 8)}`;
}

/**
 * Only branch names this module could have produced.
 *
 * `outputBranch` is stored data, and it is interpolated into a shell script — so it is treated as
 * untrusted regardless of who wrote it. Anything that does not look like a branch we minted is
 * dropped rather than escaped, because there is no legitimate way for one to appear.
 */
const WELL_FORMED = /^koala\/[a-f0-9]{8}$/;

/**
 * The branches a leaf should build on: what its dependencies actually pushed, in `dependsOn` order.
 *
 * Reads `outputBranch` rather than recomputing the name from the dependency's id, because those
 * differ in the case that matters — a dependency that succeeded without pushing anything (it
 * researched, or it decided there was nothing to do) has no branch, and checking out a name that
 * was never pushed is an error where skipping it is correct.
 */
export function baseBranchesFor(leaf: Pick<Leaf, 'dependsOn'>, all: Leaf[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of leaf.dependsOn ?? []) {
    const dep = all.find((l) => l.id === id);
    const branch = dep?.outputBranch;
    // A failed dependency's branch is deliberately still usable: the leaf only runs at all once
    // `dependenciesMet` says it may, and a partial push from a retried dependency is better to
    // build on than the default branch.
    if (!branch || !WELL_FORMED.test(branch) || seen.has(branch)) continue;
    seen.add(branch);
    out.push(branch);
  }
  return out;
}

export interface CheckoutScriptOptions {
  /** Clone URL WITH the credential in it. Moved out of `.git/config` before the agent runs. */
  cloneUrl: string;
  /** The same URL with no credential, which is what stays in `.git/config`. */
  cleanUrl: string;
  branch: string;
  /** Dependency branches to build on, in order. Empty means start from the default branch. */
  baseBranches: string[];
}

/**
 * The clone-and-position script, run before the agent gets the sandbox.
 *
 * Positional arguments carry every value, so nothing user- or model-derived is interpolated into
 * the script text. `baseBranches` is the exception and is pattern-checked above.
 */
export function buildCheckoutScript(opts: CheckoutScriptOptions): string {
  const bases = opts.baseBranches.filter((b) => WELL_FORMED.test(b));

  return [
    'set -e',
    'git clone "$0" /work/repo',
    'cd /work/repo',
    'git config user.email koala@local',
    'git config user.name Koala',
    /**
     * Strip the credential out of .git/config and hand it to the store helper instead.
     *
     * This does NOT hide the token from the agent — it lands in a file under /work, and the agent
     * can read any file it likes. Nothing can prevent that: pushing from inside the sandbox
     * requires a credential inside the sandbox. What it prevents is the token being echoed
     * incidentally, by `git remote -v`, an error message, or a command the model pastes into its
     * summary. The controls that bound the risk are its scope (this user's repos only), the egress
     * policy (Gitea is the only reachable host), and revocation at teardown.
     */
    'git remote set-url origin "$2"',
    'git config credential.helper store',
    'printf "%s\\n" "$0" > "$HOME/.git-credentials"',
    'chmod 600 "$HOME/.git-credentials"',
    '',
    // Fetch every branch: a clone gives us the default branch's history, and a dependency's
    // branch is not in it.
    'git fetch --quiet origin "+refs/heads/*:refs/remotes/origin/*" || true',
    '',
    `STARTED=0`,
    ...(bases.length
      ? [
          `for b in ${bases.join(' ')}; do`,
          // A missing branch is skipped, not fatal. It means a dependency succeeded without
          // pushing, and the right move is to carry on from whatever else there is.
          '  if ! git rev-parse --verify --quiet "origin/$b" >/dev/null; then',
          '    echo "koala: base branch $b was never pushed, skipping" >&2',
          '    continue',
          '  fi',
          '  if [ "$STARTED" = "0" ]; then',
          '    git checkout -B "$1" "origin/$b"',
          '    STARTED=1',
          '  else',
          // Second and later dependencies get merged in. A conflict is reported and abandoned
          // rather than left half-applied: an agent handed a conflicted index tends to commit it.
          '    if ! git merge --no-edit "origin/$b" >/dev/null 2>&1; then',
          '      git merge --abort || true',
          '      echo "koala: could not merge $b cleanly" >&2',
          '    fi',
          '  fi',
          'done',
        ]
      : []),
    'if [ "$STARTED" = "0" ]; then git checkout -b "$1"; fi',
  ].join('\n');
}

/**
 * Commits the agent left behind but did not push, and reports the branch if it is on the remote.
 *
 * The agent is told to push and usually does. When it does not, the work is committed inside a pod
 * that is about to be destroyed — which is the exact failure this file exists to remove, arriving
 * one step later. Pushing on its behalf is safe: the branch is the leaf's own, named after it, and
 * nothing else writes there.
 *
 * Prints the branch name on the last line only if the remote really has it, so the caller records
 * `outputBranch` from what the remote confirms rather than from the agent's say-so.
 */
export function buildPushScript(branch: string): string {
  return [
    'cd /work/repo || exit 0',
    // Nothing to do if the agent never committed. `|| true` because a repo with no commits at all
    // makes rev-parse fail, and that is a normal outcome, not an error.
    'if [ -n "$(git status --porcelain)" ]; then',
    '  git add -A && git commit -m "koala: work in progress" >/dev/null 2>&1 || true',
    'fi',
    'git push -u origin HEAD >/dev/null 2>&1 || true',
    `if [ -n "$(git ls-remote --heads origin "$0" 2>/dev/null)" ]; then echo "PUSHED:$0"; fi`,
  ].join('\n');
}

/** Reads `buildPushScript`'s last line. Absent means nothing reached the remote. */
export function parsePushedBranch(stdout: string): string | undefined {
  const match = /^PUSHED:(\S+)$/m.exec(stdout);
  return match?.[1];
}

/**
 * Lands verified work on the repository's default branch.
 *
 * ── WHY THIS EXISTS ──
 * A leaf pushed `koala/<id>` and stopped. Every repository's `main` therefore held nothing but the
 * `README.md` the initialiser wrote, so browsing Gitea showed twelve empty projects while nine
 * files of working, tested code sat on a branch nobody would think to look at. Every "verified"
 * result reported was against a branch the owner would never see by default.
 *
 * Only verified work is merged. That is what makes `verified` mean something concrete rather than
 * being a badge on a card: if the tests the work produced actually ran and passed, it lands; if
 * nothing could be checked, it stays on its branch to be looked at.
 *
 * A chain fast-forwards cleanly, because each leaf branches from the previous one's output — so
 * merging the last leaf brings everything before it. Independent leaves that both touched the same
 * file are the case that can genuinely conflict, and a conflict is reported rather than forced: the
 * work is still safe on its own branch.
 */
export function buildMergeScript(branch: string): string {
  return [
    'cd /work/repo || exit 0',
    'git fetch --quiet origin || true',
    // Detected rather than assumed: `main` is what the initialiser makes today, but a repository
    // registered from elsewhere can be on `master`, and pushing to the wrong name silently creates
    // a third branch nobody looks at either.
    'DEFAULT=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed "s|^origin/||")',
    '[ -n "$DEFAULT" ] || DEFAULT=main',
    'git rev-parse --verify --quiet "origin/$DEFAULT" >/dev/null || { echo "MERGE=skipped"; exit 0; }',
    'git checkout -B "__merge" "origin/$DEFAULT" >/dev/null 2>&1 || { echo "MERGE=skipped"; exit 0; }',
    // Fast-forward first: the common case is a chain, where the leaf's branch already contains the
    // default branch's history and a merge commit would be noise.
    'if git merge --ff-only "$0" >/dev/null 2>&1; then',
    '  :',
    'elif git merge --no-edit "$0" >/dev/null 2>&1; then',
    '  :',
    'else',
    // Left on its own branch, intact. Forcing a resolution here would mean guessing at someone
    // else's work with no way to check the result.
    '  git merge --abort >/dev/null 2>&1 || true',
    '  echo "MERGE=conflict"',
    '  exit 0',
    'fi',
    'if git push origin "HEAD:$DEFAULT" >/dev/null 2>&1; then echo "MERGE=merged"; else echo "MERGE=rejected"; fi',
  ].join('\n');
}

export type MergeOutcome = 'merged' | 'conflict' | 'rejected' | 'skipped';

/** Reads `buildMergeScript`'s verdict. Anything unrecognised is treated as "did not land". */
export function parseMergeResult(stdout: string): MergeOutcome {
  const match = /MERGE=(merged|conflict|rejected|skipped)/.exec(stdout);
  return (match?.[1] as MergeOutcome) ?? 'skipped';
}

/**
 * What the attempt actually left behind, for the next attempt to read.
 *
 * The failure recorded on a leaf was the loop's own summary — "Ran out of steps (24) without
 * calling finish. Last commands: mkdir | write | git status". That tells a retry what the previous
 * attempt TYPED and nothing about what it ACHIEVED, which is the only thing that decides whether to
 * continue or start over. Now that the repository survives a failure, the retry needs to be told
 * what is in it.
 */
export function buildRepoStateScript(): string {
  return [
    'cd /work/repo 2>/dev/null || exit 0',
    'echo "COMMITS:"',
    'git log --oneline -5 2>/dev/null || true',
    'echo "TRACKED FILES:"',
    // Names only, capped: a file listing is orientation, not content, and the whole thing is going
    // into a prompt.
    'git ls-files 2>/dev/null | head -40 || true',
    'echo "UNCOMMITTED:"',
    'git status --short 2>/dev/null | head -20 || true',
  ].join('\n');
}

/** Trims the repo-state output to something worth putting in a prompt. */
export function summariseRepoState(stdout: string): string {
  const text = stdout.trim();
  if (!text) return '';
  // A repo with no commits and no files says nothing useful — and saying "the repo is empty" is
  // better than a wall of empty headings.
  const bare = text.replace(/COMMITS:|TRACKED FILES:|UNCOMMITTED:/g, '').trim();
  if (!bare) return 'The repository is still empty — nothing was committed.';
  return text.slice(0, 1500);
}
