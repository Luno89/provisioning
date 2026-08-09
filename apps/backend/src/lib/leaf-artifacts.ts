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
 * So this asks one question and no more: is the file the leaf was asked to leave actually there,
 * committed, and not empty? It makes no claim about whether the contents are any good. Keeping that
 * boundary sharp is the point — a check that pretended to judge substance would put a "verified"
 * badge on something nothing had read.
 *
 * ── WHY THE MODEL CAN BE TRUSTED TO NAME THESE ──
 * A planner-authored verify COMMAND is a predicate whose meaning the planner controls, so it can be
 * made trivially true and launder a claim into a badge. A filename is not a predicate. The only way
 * to satisfy "produce NOTES.md" is to produce NOTES.md, and producing it is the work.
 */

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
 * Checks each declared path is tracked by git and not empty.
 *
 * Tracked, not merely present: an untracked file is in a container that is about to be deleted,
 * which is the precise failure being guarded against. `git ls-files` answers that in one call.
 */
export function buildArtifactCheckScript(paths: string[]): string {
  const safe = usablePaths(paths);
  if (safe.length === 0) return `echo "${SENTINEL}=none"`;

  return [
    'cd /work/repo 2>/dev/null || cd /work || exit 0',
    'MISSING=""',
    ...safe.flatMap((p) => [
      `if [ -z "$(git ls-files -- "${p}" 2>/dev/null)" ]; then MISSING="$MISSING ${p}(uncommitted)"`,
      // -s is "exists and has size greater than zero". A file created and never written to is not
      // the artifact anybody asked for.
      `elif [ ! -s "${p}" ]; then MISSING="$MISSING ${p}(empty)"`,
      'fi',
    ]),
    `if [ -n "$MISSING" ]; then echo "${SENTINEL}=missing$MISSING"; else echo "${SENTINEL}=present"; fi`,
  ].join('\n');
}

export type ArtifactOutcome = 'present' | 'missing' | 'none' | 'unknown';

export interface ArtifactResult {
  outcome: ArtifactOutcome;
  /** What was not there, with why — for the board and for the retry's context. */
  missing: string[];
}

export function parseArtifactResult(stdout: string): ArtifactResult {
  if (new RegExp(`${SENTINEL}=present`).test(stdout)) return { outcome: 'present', missing: [] };
  if (new RegExp(`${SENTINEL}=none`).test(stdout)) return { outcome: 'none', missing: [] };

  const match = new RegExp(`${SENTINEL}=missing(.*)`).exec(stdout);
  // No verdict at all means the script did not run — a workspace that died. Not a judgement.
  if (!match) return { outcome: 'unknown', missing: [] };

  return { outcome: 'missing', missing: (match[1] ?? '').trim().split(/\s+/).filter(Boolean) };
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
  return 'unverified';
}
