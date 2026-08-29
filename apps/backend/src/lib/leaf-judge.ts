import type { LeafEvidence } from './leaf-trace.js';

export const MAX_BUNDLE_CHARS = 24_000;

const BUDGET = {
  task: 4_000,
  diff: 12_000,
  verify: 2_000,
  expects: 5_000,
} as const;

export interface JudgeInputs {
  title: string;
  body?: string | undefined;
  expects?: string[] | undefined;
  evidence: LeafEvidence;
}

export function buildJudgeBundle(inputs: JudgeInputs): { bundle: string; dropped: string[] } {
  const dropped: string[] = [];
  const clip = (text: string, budget: number, what: string) => {
    if (text.length <= budget) return text;
    dropped.push(what);
    return `${text.slice(0, budget)}\n…[${what} truncated]`;
  };

  const parts = [
    '## The task the agent was given',
    clip([inputs.title, inputs.body ?? ''].filter(Boolean).join('\n\n'), BUDGET.task, 'task'),
  ];

  if (inputs.expects?.length) {
    parts.push('', '## Files it promised to leave behind', ...inputs.expects.map((f) => `- ${f}`));
  }

  if (inputs.evidence.diff) {
    parts.push('', '## What it actually changed', '```diff', clip(inputs.evidence.diff, BUDGET.diff, 'diff'), '```');
    if (inputs.evidence.diffTruncated) {
      parts.push('_Some changed files are not shown — lockfiles, vendored paths, or size._');
    }
  }

  if (inputs.evidence.expects?.length) {
    parts.push('', '## The files themselves');
    let spent = 0;
    for (const f of inputs.evidence.expects) {
      if (spent > BUDGET.expects) { dropped.push(`file ${f.path}`); continue; }
      parts.push('', `### ${f.path}`, '```', f.content, '```');
      spent += f.content.length;
    }
  }

  if (inputs.evidence.findings) {
    parts.push('', '## The answer it wrote', clip(inputs.evidence.findings, BUDGET.expects, 'answer'));
  }

  if (inputs.evidence.verifyOutput) {
    parts.push('', '## What the verification printed', '```', clip(inputs.evidence.verifyOutput, BUDGET.verify, 'verify output'), '```');
  }

  return { bundle: parts.join('\n').slice(0, MAX_BUNDLE_CHARS), dropped };
}

export const CODE_DIMENSIONS = [
  { name: 'implements_the_task', question: 'Does the diff implement what the task asked, or only part of it?' },
  { name: 'no_stubs', question: 'Is anything the task required left as a stub, a TODO, or a hardcoded return?' },
  { name: 'files_match_promises', question: 'Do the promised files contain what their names and the task imply?' },
  { name: 'tests_exercise_the_code', question: 'Do the tests actually exercise the new code, or are they vacuous?' },
] as const;

export const RESEARCH_DIMENSIONS = [
  { name: 'answers_the_question', question: 'Does the answer address the question asked, or a nearby one?' },
  { name: 'sources_support_claims', question: 'Are the cited sources load-bearing for the claims beside them?' },
  { name: 'no_unsupported_claims', question: 'Is any significant claim asserted with no support at all?' },
] as const;

export type DimensionVerdict = 'sound' | 'concern' | 'unsound';
export type JudgeVerdict = DimensionVerdict | 'unavailable';

export interface JudgedDimension {
  name: string;
  verdict: DimensionVerdict;
  quote: string;
  why: string;
}

export function buildJudgePrompt(bundle: string, dimensions: readonly { name: string; question: string }[]): string {
  return [
    'You are reviewing work produced by another agent. You are shown the task and what the work',
    'actually changed — nothing the agent said about it, because that is the least reliable part of',
    'the record.',
    '',
    'Answer each question below. For every answer you MUST include a short quote copied EXACTLY from',
    'the material above — a line of the diff, of a file, or of the verification output. An answer',
    'whose quote does not appear verbatim will be discarded, so quote rather than paraphrase.',
    '',
    'Be specific and be willing to say the work is fine. "sound" means no issue you can point at;',
    '"concern" means something worth a human glance; "unsound" means the task was not really done.',
    '',
    'Keep each "why" to ONE short sentence. A long answer gets cut off before it finishes, and a',
    'finding you did not finish is a finding nobody reads.',
    '',
    'Reply with JSON only, in exactly this shape:',
    '{"dimensions":[{"name":"…","verdict":"sound|concern|unsound","quote":"…","why":"…"}]}',
    '',
    'The questions:',
    ...dimensions.map((d) => `- ${d.name}: ${d.question}`),
    '',
    '---',
    bundle,
  ].join('\n');
}

function extractJson(raw: string): unknown {
  const direct = tryParse(raw.trim());
  if (direct) return direct;

  const anchor = raw.lastIndexOf('"dimensions"');
  if (anchor === -1) return undefined;

  const open = raw.lastIndexOf('{', anchor);
  if (open === -1) return undefined;

  const end = matchBrace(raw, open);
  return end === -1 ? undefined : tryParse(raw.slice(open, end + 1));
}

function recoverRows(raw: string): unknown[] {
  const rows: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue;
    const end = matchBrace(raw, i);
    if (end === -1) continue;
    const value = tryParse(raw.slice(i, end + 1)) as Record<string, unknown> | undefined;
    if (value && typeof value.name === 'string' && typeof value.verdict === 'string') {
      rows.push(value);
      i = end;
    }
  }
  return rows;
}

function matchBrace(raw: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

function tryParse(text: string): unknown {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function quotesFrom(bundle: string, quote: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const needle = flat(quote);
  if (needle.length < 12) return false;
  return flat(bundle).includes(needle);
}

export function parseJudgeReply(
  raw: string,
  bundle: string,
): { dimensions: JudgedDimension[]; fabricated: number } {
  const parsed = extractJson(raw);
  const rows = Array.isArray((parsed as { dimensions?: unknown })?.dimensions)
    ? (parsed as { dimensions: unknown[] }).dimensions
    : recoverRows(raw);
  if (!rows.length) return { dimensions: [], fabricated: 0 };

  const dimensions: JudgedDimension[] = [];
  let fabricated = 0;

  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name : '';
    const verdict = typeof r.verdict === 'string' ? r.verdict.toLowerCase() : '';
    const quote = typeof r.quote === 'string' ? r.quote : '';
    const why = typeof r.why === 'string' ? r.why : '';
    if (!name || !['sound', 'concern', 'unsound'].includes(verdict)) continue;

    if (verdict !== 'sound' && !quotesFrom(bundle, quote)) {
      fabricated++;
      continue;
    }

    dimensions.push({ name, verdict: verdict as DimensionVerdict, quote: quote.slice(0, 500), why: why.slice(0, 500) });
  }

  return { dimensions, fabricated };
}

export function combineJudgement(dimensions: JudgedDimension[]): JudgeVerdict {
  if (!dimensions.length) return 'unavailable';
  if (dimensions.some((d) => d.verdict === 'unsound')) return 'unsound';
  if (dimensions.some((d) => d.verdict === 'concern')) return 'concern';
  return 'sound';
}

export function shouldJudge(leaf: { status?: string; verified?: boolean }): boolean {
  return leaf.status === 'succeeded' && leaf.verified !== true;
}
