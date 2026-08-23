/**
 * Asking a model to read what a leaf actually produced, and holding it to what it can quote.
 *
 * ── THE LAYER THIS ADDS, AND THE ONE IT MUST NOT BECOME ──
 * Five deterministic layers already judge a leaf: the test suite, the evidence gate, the declared
 * artifacts, the research check, and the Dockerfile check. Every one of them is an exit code, a
 * regex or a file's existence, and `leaf-verify.ts` states the stance plainly — "the bar is 'did the
 * work happen', not 'is it right'".
 *
 * That stance is right, and it leaves exactly one hole: a leaf whose agent CLAIMED success where
 * nothing could check it. `decideStatus` falls back to the claim there, deliberately, because most
 * leaves are not test-shaped. This reads the diff in that case and says whether the claim is
 * plausible — a new dimension beside `verified`, never a replacement for it.
 *
 * ── WHY THE HARNESS-V2 VERSION WAS WORTHLESS, AND WHAT PREVENTS IT HERE ──
 * That branch shipped weighted rubrics — test_pass_rate 0.4, code_completeness 0.3,
 * specification_fidelity 0.3 — summed to a score with a pass mark at 80. Three problems, and only
 * the first is about rubrics:
 *
 *   1. Its inputs were fabricated. `EvaluateHarnessTaskActivity` passed a literal
 *      `gitDiff: '+export const feature = true;'` and `testResults: { passed: true }`. No rubric
 *      survives that. Fixed by lib/leaf-evidence.ts, which is a precondition rather than a detail.
 *   2. One dimension returned a constant 100, so 30% of every score was noise wearing a number.
 *   3. The score itself. A weighted mean over model-produced numbers reads as measurement and is
 *      arithmetic over opinions — and a threshold on it invites tuning the threshold.
 *
 * So: no numbers anywhere in this file, and every claim must be QUOTED from the evidence. A
 * dimension whose quote does not appear verbatim in what the model was shown is discarded before it
 * can vote. That check is mechanical, which is the point — a judge that cannot point at the diff
 * does not get an opinion.
 */
import type { LeafEvidence } from './leaf-trace.js';

/** The deployed window is 32,768 tokens (sandbox-tools.ts), so the prompt must fit ~24,000 chars. */
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
  /** What the leaf promised to leave behind, if anything. */
  expects?: string[] | undefined;
  evidence: LeafEvidence;
}

/**
 * What the judge is shown.
 *
 * Deliberately NOT the agent's conversation, trace, or summary. "Independent" cannot mean a
 * different model on an instance with one endpoint, so it means independent CONTEXT — and
 * `failure-review.ts` already states the principle this rests on: the agent's own account of what
 * it was doing is the least reliable thing in the record. Withholding it is the strongest
 * independence available here, and it costs nothing.
 */
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
      // Said INSIDE the bundle, not just recorded outside it: a judge that thinks it saw the whole
      // diff will confidently report that something is missing when it simply was not shown.
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

/**
 * The questions, as questions rather than weights.
 *
 * Each is something a reader of the diff could answer and a reader of the summary could not. The
 * last one is the highest value in the list, because it is precisely what `leaf-verify.ts`
 * disclaims: "a repository with a passing test suite it wrote is a weak signal, deliberately".
 */
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
  /** Must appear verbatim in the bundle. This is what makes the opinion checkable. */
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

/**
 * Finds the answer inside whatever the model wrapped it in.
 *
 * ── WHY NOT A GREEDY REGEX ──
 * The obvious `/\{[\s\S]*\}/` takes everything from the FIRST brace to the LAST one, which is
 * correct only when the reply contains nothing else. A reasoning model reviewing a diff quotes code
 * — braces — before it answers, so that match spans the quoted snippet AND the answer and parses as
 * neither. The failure is silent: it looks exactly like a model that produced no JSON at all.
 *
 * So: anchor on the key the answer must contain, walk back to its opening brace, and brace-match
 * forward. Falls back to parsing the whole reply, for a model that emitted nothing but JSON.
 */
function extractJson(raw: string): unknown {
  const direct = tryParse(raw.trim());
  if (direct) return direct;

  // Search from the LAST mention: the answer comes after any thinking that quoted the schema.
  const anchor = raw.lastIndexOf('"dimensions"');
  if (anchor === -1) return undefined;

  const open = raw.lastIndexOf('{', anchor);
  if (open === -1) return undefined;

  const end = matchBrace(raw, open);
  return end === -1 ? undefined : tryParse(raw.slice(open, end + 1));
}

/**
 * Salvages complete findings from a reply that was cut off mid-answer.
 *
 * ── WHY THIS IS NOT JUST BUDGET TUNING ──
 * Observed live: the judge produced a well-formed first finding — name, verdict, and a real quote
 * from the diff — and hit its token ceiling partway through the array. `JSON.parse` on an
 * unterminated array fails whole, so three good findings and a truncated fourth yielded ZERO, and
 * the leaf recorded `unavailable` as though the model had said nothing at all.
 *
 * Raising the ceiling makes that rarer and cannot make it impossible: a reply is bounded and a
 * model's verbosity is not. So a truncated answer degrades to the findings it did complete, which
 * is what a reader would do with it.
 *
 * Every recovered row still faces the quote check, so this loosens the PARSE and not the standard.
 */
function recoverRows(raw: string): unknown[] {
  const rows: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue;
    const end = matchBrace(raw, i);
    if (end === -1) continue;
    const value = tryParse(raw.slice(i, end + 1)) as Record<string, unknown> | undefined;
    // A finding, not the wrapper: the wrapper has `dimensions`, a finding has a name and a verdict.
    if (value && typeof value.name === 'string' && typeof value.verdict === 'string') {
      rows.push(value);
      i = end;
    }
  }
  return rows;
}

/** Index of the `}` closing the `{` at `open`, or -1. String-aware, so a brace in text is ignored. */
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

/** Whitespace-insensitive containment: models reflow quotes, and that is not fabrication. */
function quotesFrom(bundle: string, quote: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const needle = flat(quote);
  // A quote too short to identify anything is not evidence — "true", "const", "{".
  if (needle.length < 12) return false;
  return flat(bundle).includes(needle);
}

/**
 * Reads the model's reply and DISCARDS every dimension it cannot substantiate.
 *
 * This is the anti-fabrication device, and it is the reason this design is worth anything: a
 * dimension whose quote is not in the bundle was invented, and an invented finding is exactly what
 * a plausible-sounding judge produces. Mechanically checkable, so it is checked mechanically rather
 * than trusted.
 *
 * Discarded rather than downgraded: a fabricated quote says nothing about whether the underlying
 * concern is real, so pretending it is a milder version of itself would be inventing a second time.
 */
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

    /**
     * `sound` needs no quote.
     *
     * "I looked and found nothing wrong" cannot be evidenced by pointing at a line — there is no
     * line to point at. Requiring one would systematically discard every clean verdict and leave a
     * judge that can only ever complain, which is a bias, not a standard.
     */
    if (verdict !== 'sound' && !quotesFrom(bundle, quote)) {
      fabricated++;
      continue;
    }

    dimensions.push({ name, verdict: verdict as DimensionVerdict, quote: quote.slice(0, 500), why: why.slice(0, 500) });
  }

  return { dimensions, fabricated };
}

/**
 * One verdict from the surviving dimensions. No arithmetic.
 *
 * A 0–100 score invites a threshold, and a threshold over model-produced numbers is the harness-v2
 * failure reproduced with better inputs — it would still be averaging opinions and reading the
 * result as a measurement. Three named states carry everything a reader needs and cannot be tuned.
 *
 * No surviving dimensions means no opinion, which is different from approval.
 */
export function combineJudgement(dimensions: JudgedDimension[]): JudgeVerdict {
  if (!dimensions.length) return 'unavailable';
  if (dimensions.some((d) => d.verdict === 'unsound')) return 'unsound';
  if (dimensions.some((d) => d.verdict === 'concern')) return 'concern';
  return 'sound';
}

/**
 * Whether a leaf is in the population this judge exists for.
 *
 * ── THE SCOPE DECISION, WHICH IS A SAFETY PROPERTY RATHER THAN A POLICY ──
 * Only leaves that SUCCEEDED without anything checking them. That is the hole `decideStatus` leaves
 * open on purpose — with no verification it falls back to the agent's claim — and it is the only
 * place a model's reading adds information.
 *
 * The consequence is what matters: the judge is never shown a green suite, so it is structurally
 * incapable of overturning one. "It must not veto passing tests" stops being a rule someone could
 * loosen later and becomes a fact about which rows are fetched.
 */
export function shouldJudge(leaf: { status?: string; verified?: boolean }): boolean {
  return leaf.status === 'succeeded' && leaf.verified !== true;
}
