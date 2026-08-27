/**
 * Checking that a leaf produced the thing it was asked to produce.
 *
 * ── THE GAP THIS FILLS ──
 * Verification runs the work's own test suite. That covers code and covers nothing else: a research
 * leaf, a docs leaf, a config leaf has no suite, so the check exits "unverified" and the agent's
 * claim is believed. Which means the failure this was all built for is still live for exactly the
 * work that cannot be tested — a leaf reported "Created /work/index.js exporting getUsAqi…",
 * accurately, having committed nothing, and was marked succeeded.
 *
 * ── WHAT IT CAN AND CANNOT SAY ──
 * You cannot mechanically decide whether research reached the right answer. But that is not what
 * went wrong: what went wrong was an agent saying it produced something and producing nothing. The
 * ARTIFACT is checkable even when the ANSWER is not.
 *
 * So this asks three narrow questions and no more: is the file the leaf was asked to leave actually
 * there, committed, and different from what was already on the default branch? It makes no claim
 * about whether the contents are any GOOD. Keeping that boundary sharp is the point — a check that
 * pretended to judge substance would put a "verified" badge on something nothing had read.
 *
 * ── WHY THE MODEL CAN BE TRUSTED TO NAME THESE ──
 * A planner-authored verify COMMAND is a predicate whose meaning the planner controls, so it can be
 * made trivially true and launder a claim into a badge. A filename is not a predicate. The only way
 * to satisfy "produce NOTES.md" is to produce NOTES.md, and producing it is the work.
 */

import { extensionVariants, type FileConventions } from './tree-type-conventions.js';

/** Marks the end of the check so the verdict survives interleaved git output. */
const SENTINEL = 'KOALA_ARTIFACTS';

/**
 * Paths this module will act on.
 *
 * Interpolated into a shell script from model output, so this is an allowlist rather than an escape:
 * ordinary repository paths only, no absolute paths, no traversal, no shell metacharacters. A path
 * that does not qualify is dropped rather than sanitised, because there is no legitimate reason for
 * one to look like that and a "cleaned" version would check something nobody asked for.
 */
export function usablePaths(paths: string[]): string[] {
  return paths
    .map((p) => p.trim())
    .filter((p) => p
      && p.length <= 200
      && /^[A-Za-z0-9._/-]+$/.test(p)
      && !p.startsWith('/')
      && !p.split('/').includes('..'));
}

/**
 * Checks each declared path is tracked, not empty, and actually CHANGED by this leaf.
 *
 * Tracked, not merely present: an untracked file is in a container about to be deleted, which is
 * the first failure this guarded against.
 *
 * ── AND CHANGED, WHICH IS THE HOLE THE FIRST VERSION LEFT ──
 * Existence is not achievement. A leaf asked to rewrite `src/cli.js` could declare it, never touch
 * it, and pass — because the three-line stub a previous leaf committed is tracked and non-empty and
 * therefore satisfies every question being asked. Observed end to end: a five-leaf plan delivered a
 * CLI that printed its own name and exited, with every leaf green.
 *
 * Diffed against the DEFAULT BRANCH rather than the previous attempt. A retry inherits its own
 * earlier commits, so diffing against where this attempt started would fail a leaf for work its
 * first attempt already did; and a file that only exists on the default branch is, by definition,
 * not something this leaf produced.
 */
export function buildArtifactCheckScript(
  paths: string[],
  defaultBranch = 'main',
  conventions?: FileConventions | undefined,
): string {
  const safe = usablePaths(paths);
  if (safe.length === 0) return `echo "${SENTINEL}=none"`;
  const base = /^[A-Za-z0-9._/-]+$/.test(defaultBranch) ? defaultBranch : 'main';

  return [
    'cd /work/repo 2>/dev/null || cd /work || exit 0',
    'MISSING=""; STALE=""; MOVED=""',
    // Absent on a repository with no default branch yet — then every file is new by definition and
    // the change check is skipped rather than failing everything.
    `BASE=""; git rev-parse --verify --quiet "origin/${base}" >/dev/null 2>&1 && BASE="origin/${base}"`,
    ...safe.flatMap((p) => {
      const bn = p.split('/').pop() ?? p;
      /**
       * Basenames to search for, including the same stem under the extensions THIS TEMPLATE uses.
       *
       * A planner names paths before reading the repository, so it guesses the extension as well as
       * the directory. Measured: on a `language: 'node'` type scaffolding plain JavaScript, it asked
       * for `src/tools.ts`; the agent wrote `src/tools.js`, committed it, passed 34 tests, and the
       * leaf was failed three times for the letter. The scaffold already says which extension the
       * project uses — see lib/tree-type-conventions.ts — so use it rather than fail correct work.
       *
       * Re-validated through `usablePaths` because these are interpolated into a shell script, even
       * though they are derived from an already-validated path plus a fixed extension list.
       */
      const variants = usablePaths(conventions ? extensionVariants(p, conventions) : [])
        .map((v) => v.split('/').pop() ?? v);
      const names = [bn, ...variants.filter((v) => v !== bn)];
      const globs = names.flatMap((n) => [`"*/${n}"`, `"${n}"`]).join(' ');
      return [
        `if [ -n "$(git ls-files -- "${p}" 2>/dev/null)" ]; then`,
        // -s is "exists and has size greater than zero". A file created and never written to is
        // not the artifact anybody asked for.
        `  if [ ! -s "${p}" ]; then MISSING="$MISSING ${p}(empty)"`,
        `  elif [ -n "$BASE" ] && git diff --quiet "$BASE" -- "${p}" 2>/dev/null; then STALE="$STALE ${p}"`,
        '  fi',
        'else',
        /**
         * Not at the path that was named — so look for it by NAME before calling it missing.
         *
         * The planner names these paths while decomposing, before anyone has seen the repository,
         * so it guesses the layout. Measured: it asked for `src/util/version.test.js`; the agent
         * read the repo, saw tests live in `test/`, and wrote `test/version.test.js`. The work was
         * correct, committed and passing, and the leaf was failed for the directory.
         *
         * Only a candidate this leaf actually CHANGED counts, which is what keeps this from
         * turning into "some file with this name exists somewhere".
         */
        `  BN_FOUND=""`,
        `  for CAND in $(git ls-files -- ${globs} 2>/dev/null | head -20); do`,
        '    if [ -s "$CAND" ] && { [ -z "$BASE" ] || ! git diff --quiet "$BASE" -- "$CAND" 2>/dev/null; }; then',
        '      BN_FOUND="$CAND"; break',
        '    fi',
        '  done',
        `  if [ -n "$BN_FOUND" ]; then MOVED="$MOVED ${p}->$BN_FOUND"; else MISSING="$MISSING ${p}(uncommitted)"; fi`,
        'fi',
      ];
    }),
    'if [ -n "$MOVED" ]; then echo "' + SENTINEL + '_MOVED=$MOVED"; fi',
    // Missing beats stale: something that does not exist anywhere is the failure this check is for,
    // and something present-but-untouched is a weaker statement that must not hide it.
    `if [ -n "$MISSING" ]; then echo "${SENTINEL}=missing$MISSING"`,
    `elif [ -n "$STALE" ]; then echo "${SENTINEL}=stale$STALE"`,
    `else echo "${SENTINEL}=present"; fi`,
  ].join('\n');
}

export type ArtifactOutcome = 'present' | 'missing' | 'stale' | 'none' | 'unknown';

export interface ArtifactResult {
  outcome: ArtifactOutcome;
  /** What was not there, with why — for the board and for the retry's context. */
  missing: string[];
  /** Declared at one path, found at another. Reported so a wrong guess is visible, not silent. */
  moved: string[];
}

export function parseArtifactResult(stdout: string): ArtifactResult {
  const movedMatch = new RegExp(`${SENTINEL}_MOVED(.*)`).exec(stdout);
  const moved = (movedMatch?.[1] ?? '').replace(/^=/, '').trim().split(/\s+/).filter(Boolean);

  if (new RegExp(`${SENTINEL}=present`).test(stdout)) return { outcome: 'present', missing: [], moved };
  if (new RegExp(`${SENTINEL}=none`).test(stdout)) return { outcome: 'none', missing: [], moved };

  const stale = new RegExp(`${SENTINEL}=stale(.*)`).exec(stdout);
  if (stale) {
    return { outcome: 'stale', missing: (stale[1] ?? '').trim().split(/\s+/).filter(Boolean), moved };
  }

  const match = new RegExp(`${SENTINEL}=missing(.*)`).exec(stdout);
  // No verdict at all means the script did not run — a workspace that died. Not a judgement.
  if (!match) return { outcome: 'unknown', missing: [], moved };

  return { outcome: 'missing', missing: (match[1] ?? '').trim().split(/\s+/).filter(Boolean), moved };
}

/**
 * One verdict from the two independent checks.
 *
 * Either failing is a failure: tests that pass while a promised file is absent means the leaf did
 * part of its job, and a present file with a red suite means it broke something. Either passing is
 * enough to call the leaf verified, because each is a real mechanical check — a research leaf has
 * no suite and a code leaf may declare no artifacts, and demanding both would make one of those
 * permanently unverifiable.
 */
export function combineVerification(
  tests: 'passed' | 'failed' | 'unverified',
  artifacts: ArtifactOutcome,
): 'passed' | 'failed' | 'unverified' {
  if (tests === 'failed' || artifacts === 'missing') return 'failed';
  if (tests === 'passed' || artifacts === 'present') return 'passed';
  /**
   * `stale` is deliberately NOT a failure.
   *
   * It means the declared file is there, committed and non-empty, but this leaf did not change it
   * — usually because a sibling leaf produced it first. That is not the failure this check exists
   * for: nobody claimed something and delivered nothing. Measured, twice, that it fails work which
   * is complete and correct, and the retry it triggers can never succeed because there is nothing
   * left to create.
   *
   * It is not a pass either — nothing here proves this leaf improved anything — so it lands on
   * `unverified`, which succeeds the leaf on its claim and leaves the board saying "claimed"
   * rather than "verified". That distinction already exists precisely for this.
   */
  return 'unverified';
}
