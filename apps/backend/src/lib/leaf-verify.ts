/**
 * Judging a leaf on the repository rather than on what the agent says about it.
 *
 * ── BOTH DIRECTIONS OF THIS WERE OBSERVED LIVE ──
 * A leaf is currently `succeeded` when the agent calls `finish(succeeded: true)` and `failed`
 * otherwise. That is a claim, not a result, and it is wrong in both directions:
 *
 *   · A leaf reported "Created /work/index.js exporting getUsAqi…" — accurate about what it had
 *     written and useless, because nothing had been committed and the pod was about to be
 *     destroyed. The board said succeeded.
 *   · A leaf capped at 7 steps failed all three attempts, and the accumulated branch contained all
 *     nine expected files with nine passing tests. The board said failed. The work was done.
 *
 * The agent's report and the state of the repository are different things, and only one of them is
 * checkable. This runs a command in the workspace and believes the exit code.
 *
 * ── WHY A DEFAULT COMMAND, AND NOT ONLY AN AUTHORED ONE ──
 * An experiment task carries a `verifyCommand` written against a known solution and gated two-sided
 * (it must FAIL on the seed alone and PASS on seed plus solution). A leaf has no solution to gate
 * against, so a model-authored command here cannot be validated the same way and a trivially-true
 * one would be worse than nothing — it would launder a claim into a "verified" badge.
 *
 * So the default is not authored at all: run the tests the work itself produced. A repository with
 * a passing test suite it wrote is a weak signal, deliberately — it does not prove the task was
 * done, only that what exists holds together. Absence of any suite is reported as unverified rather
 * than as failure, because most leaves are not test-shaped and calling them all failures would make
 * the signal useless.
 */
import type { WorkspaceLanguage } from './workspace-spec.js';

/** Marks the end of the verify output so the exit code survives interleaved stdout/stderr. */
const SENTINEL = 'KOALA_VERIFY_EXIT';

export type VerifyOutcome =
  /** A command ran and passed. */
  | 'passed'
  /** A command ran and failed. */
  | 'failed'
  /** Nothing to run — no authored command and nothing detected. Not a judgement either way. */
  | 'unverified';

export interface VerifyResult {
  outcome: VerifyOutcome;
  /** Tail of the command's output, for the board and for the next attempt's context. */
  output: string;
}

/**
 * The command to run when the leaf did not bring its own.
 *
 * Detection is done in the shell rather than here, because this process cannot see the workspace —
 * the script checks for the files and exits `unverified` when they are absent.
 */
export function defaultVerifyCommand(language: WorkspaceLanguage | undefined): string | undefined {
  switch (language ?? 'node') {
    case 'node':
      /**
       * `test/*.test.js`, never `node --test test/`.
       *
       * On current Node the bare directory form resolves `test/` as a MODULE, fails with
       * MODULE_NOT_FOUND, and reports one failing test — which reads as a real failure of the work.
       * It cost me a false report against an agent whose code was correct, twice.
       */
      // Both layouts. A repo whose tests sit at the root read as "no suite" and fell back to the
      // agent's claim — caught while backfilling: two repositories with green suites were being
      // scored as unverified purely because of where the files were.
      // Two invocations, so one pattern matching nothing does not suppress the other's output.
      return 'node --test $(ls test/*.test.js 2>/dev/null; ls *.test.js 2>/dev/null)';
    case 'python':
      return 'python -m pytest -q';
    case 'go':
      return 'go test ./...';
    // 'base' has no toolchain to run anything with.
    default:
      return undefined;
  }
}

/**
 * Wraps a verify command so its exit code comes back through stdout.
 *
 * Exits 127 when there is nothing to verify, which the parser maps to `unverified` — distinct from
 * the command running and failing. A missing test suite is not a broken leaf.
 */
export function buildVerifyScript(command: string, language: WorkspaceLanguage | undefined): string {
  const guard = (language ?? 'node') === 'node'
    // The glob must match something, or the shell passes the pattern through literally and node
    // reports a missing file as a test failure. Checks both layouts for the same reason the
    // command does.
    /**
     * Each pattern tested SEPARATELY.
     *
     * `ls a b` exits non-zero when either operand is missing, even when the other matched — so a
     * single `ls test/*.test.js *.test.js` reported "no suite" for every repository that keeps its
     * tests in test/ and nothing beside the source. Caught live: two leaves with green suites came
     * back unverified, which then silently fell through to trusting the agent's claim.
     */
    ? 'ls test/*.test.js >/dev/null 2>&1 || ls *.test.js >/dev/null 2>&1 || { echo "' + SENTINEL + '=127"; exit 0; }'
    : '';

  return [
    'cd /work/repo 2>/dev/null || cd /work || exit 0',
    ...(guard ? [guard] : []),
    // Output is captured whether it passes or fails: a failing suite's output is the most useful
    // thing the next attempt could be handed.
    `${command} 2>&1 | tail -60`,
    `echo "${SENTINEL}=\${PIPESTATUS[0]:-$?}"`,
  ].join('\n');
}

export function parseVerifyResult(stdout: string): VerifyResult {
  const match = new RegExp(`${SENTINEL}=(\\d+)`).exec(stdout);
  const output = stdout.replace(new RegExp(`${SENTINEL}=\\d+\\s*$`), '').trim().slice(-2000);

  // No sentinel means the script itself did not complete — a workspace that died, or a command
  // that never returned. Not something to call a failure of the work.
  if (!match) return { outcome: 'unverified', output };

  const code = Number(match[1]);
  if (code === 127) return { outcome: 'unverified', output };
  return { outcome: code === 0 ? 'passed' : 'failed', output };
}

/**
 * What the leaf's status should be, given what the agent claimed and what the repository shows.
 *
 * Verification wins in both directions when it ran. That is the entire point: a claim that
 * disagrees with a green suite is a claim, and a green suite under a leaf that ran out of steps is
 * still work that holds together.
 */
export function decideStatus(claimed: boolean, verify: VerifyOutcome): 'succeeded' | 'failed' {
  if (verify === 'passed') return 'succeeded';
  if (verify === 'failed') return 'failed';
  // Nothing to check against — fall back to the claim, and record that it was unverified so the
  // board can say so rather than implying it was checked.
  return claimed ? 'succeeded' : 'failed';
}
