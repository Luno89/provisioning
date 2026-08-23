/**
 * What a run actually produced, captured before the sandbox is destroyed.
 *
 * ── WHY THIS IS WORTH DOING EVEN IF NOTHING READS IT ──
 * `failure-review.ts` exists to diagnose a failed leaf, and it has never been given a DIFF. It sees
 * the agent's summary and the error text — the two least reliable things in the record — and
 * nothing the run actually wrote. "Did the tests exercise the new code, or are they vacuous" has
 * been unanswerable for every leaf this codebase has ever run.
 *
 * ── AND WHY IT IS A PRECONDITION FOR ANY JUDGE ──
 * The abandoned harness-v2 branch scored work with a weighted rubric fed
 * `gitDiff: '+export const feature = true;'` and `testResults: { passed: true }`, both hardcoded.
 * Its verdict carried no information about the work, and would have carried none however good the
 * rubric was. A judge is exactly as good as the artifacts it reads, so the artifacts come first and
 * separately — this module calls no model and has no opinion.
 *
 * ── BOUNDED ON PURPOSE ──
 * A diff can be a megabyte and a repository can hold ten thousand files. Everything here has a
 * ceiling, and a truncation is RECORDED rather than silent: a reader who cannot tell a small diff
 * from a clipped one will draw confident conclusions from the wrong half.
 */
import type { LeafEvidence } from './leaf-trace.js';

/** Roughly what fits alongside a task description in a 32k-token window, with room for a reply. */
export const MAX_DIFF_CHARS = 12_000;
export const MAX_EXPECT_FILES = 5;
export const MAX_EXPECT_CHARS = 4_000;

/**
 * Paths whose contents say nothing about the work.
 *
 * A lockfile diff is thousands of lines that mean "a dependency was added" — true, and not worth
 * the entire budget. The vendored set matches the filter the repository-layout extractor already
 * uses, so the two agree about what counts as the project.
 */
const NOISE = /^(node_modules|vendor|\.venv|venv|dist|build|__pycache__|\.koala)\/|(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)$/;

export interface CaptureInputs {
  workspaces: {
    exec(id: string, script: string, timeoutMs?: number, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    readFile(id: string, path: string): Promise<string>;
  };
  leafId: string;
  /** The branch this leaf's work is measured against. Absent for a persona with no repository. */
  base?: string | undefined;
  expects?: string[] | undefined;
  verifyOutput?: string | undefined;
  findings?: string | undefined;
}

/**
 * The diff script.
 *
 * `--stat` first so the shape is known even when the patches are clipped, then the patches
 * themselves. `$0` is the base ref, passed as argv — nothing is interpolated, for the same reason
 * every other script in this codebase takes positionals.
 */
export function buildDiffScript(): string {
  return [
    'cd /work/repo 2>/dev/null || exit 0',
    'echo "STAT:"',
    'git diff --stat "origin/$0..HEAD" 2>/dev/null || git diff --stat HEAD 2>/dev/null || true',
    'echo "PATCH:"',
    // No colour, no pager, and a per-file cap so one generated file cannot eat the whole budget.
    'git diff --no-color --unified=3 "origin/$0..HEAD" 2>/dev/null || git diff --no-color --unified=3 HEAD 2>/dev/null || true',
  ].join('\n');
}

/**
 * Keeps the parts of a patch that describe the project, in file order, until the budget runs out.
 *
 * Filtering by path rather than by size: a large hand-written file is exactly what a reader wants,
 * and a small lockfile change is exactly what they do not. Returns whether anything was dropped so
 * the caller can say so.
 */
export function trimDiff(raw: string, budget = MAX_DIFF_CHARS): { diff: string; truncated: boolean } {
  const [statPart = '', patchPart = ''] = raw.split('PATCH:');
  const stat = statPart.replace(/^STAT:\s*/, '').trim();

  // `git diff` separates files with a line beginning `diff --git`.
  const files = patchPart.split(/^(?=diff --git )/m).filter((f) => f.trim());
  const kept: string[] = [];
  let used = stat.length;
  let dropped = 0;

  for (const file of files) {
    const path = /^diff --git a\/(\S+)/.exec(file)?.[1] ?? '';
    if (path && NOISE.test(path)) { dropped++; continue; }
    if (used + file.length > budget) { dropped++; continue; }
    kept.push(file.trimEnd());
    used += file.length;
  }

  const parts = [stat, ...kept].filter(Boolean);
  if (dropped > 0) {
    // Stated, not implied. A clipped diff that looks whole is worse than no diff.
    parts.push(`[${dropped} more changed file(s) not shown — lockfiles, vendored paths, or beyond the size budget]`);
  }
  return { diff: parts.join('\n\n'), truncated: dropped > 0 };
}

/**
 * Reads everything worth keeping out of a sandbox that is about to be destroyed.
 *
 * Every step is independently soft. A repository that cannot be diffed still has declared artifacts
 * worth reading; a file that cannot be read should not cost the diff. Partial evidence is useful and
 * no evidence is the status quo, so nothing here is allowed to throw.
 */
export async function captureEvidence(inputs: CaptureInputs): Promise<LeafEvidence> {
  const evidence: LeafEvidence = { capturedAt: new Date().toISOString() };

  if (inputs.base) {
    const raw = await inputs.workspaces
      .exec(inputs.leafId, buildDiffScript(), 60_000, [inputs.base])
      .then((r) => r.stdout)
      .catch(() => '');
    if (raw.trim()) {
      const { diff, truncated } = trimDiff(raw);
      if (diff) {
        evidence.diff = diff;
        if (truncated) evidence.diffTruncated = true;
      }
    }
  }

  if (inputs.expects?.length) {
    const files: NonNullable<LeafEvidence['expects']> = [];
    for (const path of inputs.expects.slice(0, MAX_EXPECT_FILES)) {
      // Declared paths are repo-relative; the checkout lives at /work/repo.
      const full = path.startsWith('/') ? path : `/work/repo/${path}`;
      const content = await inputs.workspaces.readFile(inputs.leafId, full).catch(() => '');
      if (!content) continue;
      files.push({
        path,
        content: content.slice(0, MAX_EXPECT_CHARS),
        ...(content.length > MAX_EXPECT_CHARS ? { truncated: true } : {}),
      });
    }
    if (files.length) evidence.expects = files;
  }

  if (inputs.verifyOutput?.trim()) evidence.verifyOutput = inputs.verifyOutput;
  if (inputs.findings?.trim()) evidence.findings = inputs.findings;

  return evidence;
}
