/**
 * Whether a research leaf actually answered the question.
 *
 * ── WHY LENGTH IS NOT ENOUGH ──
 * The first version of this check asked only whether the findings file was non-empty. Measured on a
 * live run: the agent was told to write the file before searching, so it wrote a tidy markdown
 * OUTLINE — every heading present, every section a placeholder, "Sources: (To be filled)" — called
 * `finish`, and passed. 406 characters, verified true, and not one fact in it.
 *
 * That is the same failure the whole verification effort exists to stop, one level up: a check with
 * no teeth converts a claim into a badge. A test suite proves code; the equivalent for research is
 * that it says something and shows where it came from.
 *
 * ── WHAT THIS DOES AND DOES NOT CLAIM ──
 * It does not judge whether the answer is correct — nothing here could. It asks three things a real
 * answer has and a stub does not: enough prose to be an answer, at least one source, and no
 * unfilled placeholders. A determined agent could still satisfy all three with nonsense, exactly as
 * it could write a passing test that asserts nothing. The bar is "did the work happen", not "is it
 * right".
 */

/** Short enough that a terse but genuine answer passes; long enough to exclude a stub. */
export const MIN_FINDINGS_CHARS = 400;

/**
 * Markers of a section the agent meant to come back to.
 *
 * Taken from what a real run actually produced rather than invented — "(To be filled)" is verbatim
 * from the outline that passed. Matched case-insensitively and only as whole phrases, so prose
 * legitimately discussing a TODO list is not caught by the word alone.
 */
const PLACEHOLDERS = [
  /\(\s*to be (filled|completed|determined|added)\s*\)/i,
  /\bTBD\b/,
  /\bTODO\b/,
  /\[\s*(placeholder|fill in|insert)\b[^\]]*\]/i,
  /\bcoming soon\b/i,
];

/**
 * http(s) only. A bare domain is something the agent typed; a URL is something it can be checked
 * against.
 *
 * Deliberately NOT global. `.test()` on a /g regex advances `lastIndex` and resumes from there on
 * the next call, so a shared pattern silently returns false for a string it matches — intermittent,
 * order-dependent, and exactly the kind of thing that would fail one leaf in five for no visible
 * reason.
 */
const URL_PATTERN = /https?:\/\/[^\s)<>\]]+/;

export interface FindingsVerdict {
  outcome: 'passed' | 'failed';
  /** Empty when passed. Written to be read by the next attempt, so it says what to do differently. */
  reason: string;
}

export function assessFindings(raw: string, path = '/work/findings.md'): FindingsVerdict {
  const text = (raw ?? '').trim();
  if (!text) return { outcome: 'failed', reason: `nothing was written to ${path}` };

  const placeholder = PLACEHOLDERS.find((p) => p.test(text));
  if (placeholder) {
    return {
      outcome: 'failed',
      reason: `${path} still contains unfilled placeholders — it is an outline, not an answer`,
    };
  }

  /**
   * Length measured on the PROSE, not the file.
   *
   * A skeleton of headings can clear a raw character count while saying nothing, which is precisely
   * how the stub passed. Stripping markdown structure leaves what was actually written.
   */
  const prose = text
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/^\s*[-*+]\s*$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();
  if (prose.length < MIN_FINDINGS_CHARS) {
    return {
      outcome: 'failed',
      reason: `${path} has ${prose.length} characters of content, below the ${MIN_FINDINGS_CHARS} expected of an answer`,
    };
  }

  // Sources are the one artefact of having actually looked something up. The leaf is told to cite
  // them, so their absence is a failure to follow the brief, not an unfair surprise.
  if (!URL_PATTERN.test(text)) {
    return { outcome: 'failed', reason: `${path} cites no sources — every claim needs a URL it came from` };
  }

  return { outcome: 'passed', reason: '' };
}
