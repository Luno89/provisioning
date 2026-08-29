
export const MIN_FINDINGS_CHARS = 400;

const PLACEHOLDERS = [
  /\(\s*to be (filled|completed|determined|added)\s*\)/i,
  /\bTBD\b/,
  /\bTODO\b/,
  /\[\s*(placeholder|fill in|insert)\b[^\]]*\]/i,
  /\bcoming soon\b/i,
];

const URL_PATTERN = /https?:\/\/[^\s)<>\]]+/;

export interface FindingsVerdict {
  outcome: 'passed' | 'failed';
  reason: string;
}

export function assessFindings(
  raw: string,
  path = '/work/findings.md',
  requireSources = true,
): FindingsVerdict {
  const text = (raw ?? '').trim();
  if (!text) return { outcome: 'failed', reason: `nothing was written to ${path}` };

  const placeholder = PLACEHOLDERS.find((p) => p.test(text));
  if (placeholder) {
    return {
      outcome: 'failed',
      reason: `${path} still contains unfilled placeholders — it is an outline, not an answer`,
    };
  }

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

  if (requireSources && !URL_PATTERN.test(text)) {
    return { outcome: 'failed', reason: `${path} cites no sources — every claim needs a URL it came from` };
  }

  return { outcome: 'passed', reason: '' };
}
