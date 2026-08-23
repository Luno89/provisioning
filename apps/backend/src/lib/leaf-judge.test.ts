import { describe, it, expect } from 'vitest';
import {
  buildJudgeBundle, buildJudgePrompt, parseJudgeReply, combineJudgement, shouldJudge,
  CODE_DIMENSIONS, MAX_BUNDLE_CHARS,
} from './leaf-judge.js';

const evidence = (over: any = {}) => ({ capturedAt: '2026-08-21T00:00:00Z', ...over });

describe('what the judge is shown', () => {
  it('shows the task and the diff', () => {
    const { bundle } = buildJudgeBundle({
      title: 'Add a rate limiter', body: 'Token bucket, 100 rps.',
      evidence: evidence({ diff: '+const bucket = new TokenBucket(100);' }),
    });
    expect(bundle).toContain('Add a rate limiter');
    expect(bundle).toContain('TokenBucket(100)');
  });

  /**
   * "Independent" cannot mean a different model on an instance with one endpoint, so it means
   * independent CONTEXT. failure-review.ts already states the principle: the agent's own account of
   * what it was doing is the least reliable thing in the record.
   */
  it('never shows the agent’s own account of itself', () => {
    const { bundle } = buildJudgeBundle({
      title: 'Add a rate limiter',
      evidence: evidence({ diff: '+x', verifyOutput: 'ok' }),
    });
    expect(bundle).not.toMatch(/summary|the agent (said|reported)|conversation|transcript/i);
  });

  it('fits the window it has to fit', () => {
    const { bundle } = buildJudgeBundle({
      title: 't', body: 'b'.repeat(50_000),
      evidence: evidence({ diff: 'd'.repeat(200_000), findings: 'f'.repeat(50_000) }),
    });
    expect(bundle.length).toBeLessThanOrEqual(MAX_BUNDLE_CHARS);
  });

  /**
   * A judge that thinks it saw the whole diff will confidently report something missing when it
   * simply was not shown — so the truncation is stated INSIDE the bundle, not only recorded beside
   * it.
   */
  it('tells the judge when it is looking at a partial diff', () => {
    const { bundle } = buildJudgeBundle({
      title: 't', evidence: evidence({ diff: '+x', diffTruncated: true }),
    });
    expect(bundle).toMatch(/not shown/i);
  });

  it('reports what it had to drop', () => {
    const { dropped } = buildJudgeBundle({ title: 't', evidence: evidence({ diff: 'd'.repeat(50_000) }) });
    expect(dropped).toContain('diff');
  });
});

/**
 * ── THE ANTI-FABRICATION DEVICE ──
 * A dimension whose quote is not in the bundle was invented, and an invented finding is exactly
 * what a plausible-sounding judge produces. Mechanically checkable, so it is checked mechanically
 * rather than trusted — this is the reason the whole design is worth anything.
 */
describe('holding the judge to what it can quote', () => {
  const bundle = 'The diff adds:\n+const bucket = new TokenBucket(100);\n+// TODO: wire the middleware';

  it('keeps a finding that quotes the evidence', () => {
    const out = parseJudgeReply(JSON.stringify({
      dimensions: [{ name: 'no_stubs', verdict: 'unsound', quote: '// TODO: wire the middleware', why: 'left as a stub' }],
    }), bundle);

    expect(out.dimensions).toHaveLength(1);
    expect(out.fabricated).toBe(0);
  });

  it('DISCARDS a finding whose quote is nowhere in the evidence', () => {
    const out = parseJudgeReply(JSON.stringify({
      dimensions: [{ name: 'no_stubs', verdict: 'unsound', quote: 'throw new Error("not implemented yet")', why: 'stubbed' }],
    }), bundle);

    expect(out.dimensions).toHaveLength(0);
    expect(out.fabricated).toBe(1);
  });

  it('forgives reflowed whitespace, which is not fabrication', () => {
    const out = parseJudgeReply(JSON.stringify({
      dimensions: [{ name: 'no_stubs', verdict: 'concern', quote: '+const   bucket = new TokenBucket(100);', why: 'x' }],
    }), bundle);
    expect(out.dimensions).toHaveLength(1);
  });

  it('rejects a quote too short to identify anything', () => {
    // "true", "const", "{" — technically present, evidence of nothing.
    const out = parseJudgeReply(JSON.stringify({
      dimensions: [{ name: 'no_stubs', verdict: 'unsound', quote: 'const', why: 'x' }],
    }), bundle);
    expect(out.dimensions).toHaveLength(0);
  });

  /**
   * "I looked and found nothing wrong" cannot be evidenced by pointing at a line — there is no line
   * to point at. Requiring one would discard every clean verdict and leave a judge that can only
   * complain, which is a bias rather than a standard.
   */
  it('lets a clean verdict stand without a quote', () => {
    const out = parseJudgeReply(JSON.stringify({
      dimensions: [{ name: 'implements_the_task', verdict: 'sound', quote: '', why: 'the diff does what was asked' }],
    }), bundle);
    expect(out.dimensions).toHaveLength(1);
  });

  it('survives a model that wraps its JSON in prose', () => {
    const out = parseJudgeReply(
      'Sure! Here is my review:\n```json\n{"dimensions":[{"name":"x","verdict":"sound","quote":"","why":"fine"}]}\n```',
      bundle,
    );
    expect(out.dimensions).toHaveLength(1);
  });

  it('returns nothing rather than throwing on unparseable output', () => {
    expect(parseJudgeReply('I cannot comply.', bundle).dimensions).toHaveLength(0);
    expect(parseJudgeReply('', bundle).dimensions).toHaveLength(0);
  });

  it('ignores a row with a verdict it does not recognise', () => {
    const out = parseJudgeReply(JSON.stringify({
      dimensions: [{ name: 'x', verdict: 'excellent', quote: '', why: '' }],
    }), bundle);
    expect(out.dimensions).toHaveLength(0);
  });
});

/**
 * A 0–100 score invites a threshold, and a threshold over model-produced numbers is the harness-v2
 * failure reproduced with better inputs. Three named states carry what a reader needs and cannot be
 * tuned.
 */
describe('combining into one verdict, without arithmetic', () => {
  const d = (verdict: any) => ({ name: 'x', verdict, quote: 'q', why: 'w' });

  it('takes the worst surviving finding', () => {
    expect(combineJudgement([d('sound'), d('concern'), d('unsound')])).toBe('unsound');
    expect(combineJudgement([d('sound'), d('concern')])).toBe('concern');
    expect(combineJudgement([d('sound'), d('sound')])).toBe('sound');
  });

  it('says "unavailable" when nothing survived, not "sound"', () => {
    // No opinion is different from approval, and a judge whose findings were all fabricated has
    // no opinion.
    expect(combineJudgement([])).toBe('unavailable');
  });
});

/**
 * ── SCOPE AS A SAFETY PROPERTY ──
 * Only leaves that succeeded without anything checking them — the hole decideStatus leaves open on
 * purpose. The consequence is that the judge is never SHOWN a green suite, so it is structurally
 * incapable of overturning one: "must not veto passing tests" stops being a rule someone could
 * loosen and becomes a fact about which rows are fetched.
 */
describe('which leaves are judged at all', () => {
  it('judges a success nothing checked', () => {
    expect(shouldJudge({ status: 'succeeded', verified: false })).toBe(true);
    expect(shouldJudge({ status: 'succeeded' })).toBe(true);
  });

  it('never sees a verified leaf', () => {
    expect(shouldJudge({ status: 'succeeded', verified: true })).toBe(false);
  });

  it('never sees a failure', () => {
    // A failed leaf already has a reason; a second opinion costs a call and adds nothing.
    expect(shouldJudge({ status: 'failed', verified: false })).toBe(false);
    expect(shouldJudge({ status: 'running' })).toBe(false);
  });
});

describe('the prompt', () => {
  it('demands a verbatim quote and says what happens without one', () => {
    const prompt = buildJudgePrompt('BUNDLE', CODE_DIMENSIONS);
    expect(prompt).toMatch(/copied EXACTLY/);
    expect(prompt).toMatch(/will be discarded/);
    expect(prompt).toContain('BUNDLE');
  });

  it('invites a clean verdict, so the judge is not fishing', () => {
    expect(buildJudgePrompt('B', CODE_DIMENSIONS)).toMatch(/willing to say the work is fine/);
  });

  it('asks whether the tests actually exercise the code', () => {
    // The highest-value question here: precisely what leaf-verify.ts disclaims about its own signal.
    expect(buildJudgePrompt('B', CODE_DIMENSIONS)).toMatch(/vacuous/);
  });
});

/**
 * Finding the answer inside a reasoning model's reply.
 *
 * The first version used `/\{[\s\S]*\}/`, which takes everything from the FIRST brace to the LAST.
 * That is right only when the reply contains nothing else — and a reasoning model reviewing a diff
 * quotes code, which means braces, before it answers. The match then spans the quoted snippet and
 * the answer, parses as neither, and fails in a way indistinguishable from a model that produced no
 * JSON at all.
 */
describe('digging the JSON out of a thinking model', () => {
  const bundle = 'a diff containing const config = { retries: 3 };';

  it('finds the answer after quoted code that contains braces', () => {
    const raw = [
      'Let me look. The diff has `const config = { retries: 3 };` which is fine.',
      'Now the JSON:',
      '{"dimensions":[{"name":"implements_the_task","verdict":"sound","quote":"","why":"does what was asked"}]}',
    ].join('\n');

    const out = parseJudgeReply(raw, bundle);
    expect(out.dimensions).toHaveLength(1);
    expect(out.dimensions[0]?.name).toBe('implements_the_task');
  });

  it('takes the LAST answer when the model restates the schema first', () => {
    // Reasoning models frequently echo the requested shape before filling it in.
    const raw = [
      'The shape is {"dimensions":[{"name":"…","verdict":"…"}]} so I will produce:',
      '{"dimensions":[{"name":"no_stubs","verdict":"sound","quote":"","why":"nothing stubbed"}]}',
    ].join('\n');

    const out = parseJudgeReply(raw, bundle);
    expect(out.dimensions).toHaveLength(1);
    expect(out.dimensions[0]?.name).toBe('no_stubs');
  });

  it('still handles a reply that is nothing but JSON', () => {
    const raw = '{"dimensions":[{"name":"x","verdict":"sound","quote":"","why":"y"}]}';
    expect(parseJudgeReply(raw, bundle).dimensions).toHaveLength(1);
  });

  it('is not fooled by a brace inside a string', () => {
    const raw = '{"dimensions":[{"name":"x","verdict":"concern","quote":"const config = { retries: 3 };","why":"see the } here"}]}';
    const out = parseJudgeReply(raw, bundle);
    expect(out.dimensions).toHaveLength(1);
    expect(out.dimensions[0]?.quote).toContain('retries: 3');
  });

  it('gives up quietly when there is no answer at all', () => {
    expect(parseJudgeReply('I thought about it and { gave up', bundle).dimensions).toHaveLength(0);
  });
});

/**
 * Salvaging a reply that ran out of room mid-answer.
 *
 * Observed live: the judge produced a well-formed first finding — name, verdict, and a real quote
 * from the diff — then hit its token ceiling partway through the array. `JSON.parse` on an
 * unterminated array fails whole, so good findings plus a truncated one yielded ZERO and the leaf
 * recorded `unavailable` as though the model had said nothing. Raising the ceiling makes that
 * rarer; it cannot make it impossible, because a reply is bounded and verbosity is not.
 */
describe('a reply that was cut off', () => {
  const bundle = 'the diff adds:\n+function truncate(text, max) {\n+  return text.slice(0, max);';

  it('keeps the findings that completed and drops the one that did not', () => {
    const raw = '{"dimensions":['
      + '{"name":"implements_the_task","verdict":"sound","quote":"","why":"does what was asked"},'
      // A quote containing an unbalanced brace, to prove the matcher is string-aware.
      + '{"name":"no_stubs","verdict":"concern","quote":"+function truncate(text, max) {","why":"no body"},'
      + '{"name":"files_match_promises","verdict":"sou';

    const out = parseJudgeReply(raw, bundle);
    expect(out.dimensions).toHaveLength(2);
    expect(out.dimensions.map((d) => d.name)).toEqual(['implements_the_task', 'no_stubs']);
  });

  it('drops only the finding that did not finish', () => {
    const raw = '{"dimensions":[{"name":"a","verdict":"sound","quote":"","why":"fine"},{"name":"b","verdi';
    expect(parseJudgeReply(raw, bundle).dimensions).toHaveLength(1);
  });

  /**
   * Loosening the PARSE must not loosen the standard: a recovered finding still has to point at
   * something real, or the salvage becomes a way to smuggle fabrications past the check.
   */
  it('still holds a recovered finding to its quote', () => {
    const raw = '{"dimensions":[{"name":"a","verdict":"unsound","quote":"throw new Error(\\"not implemented\\")","why":"stub"},';
    const out = parseJudgeReply(raw, bundle);
    expect(out.dimensions).toHaveLength(0);
    expect(out.fabricated).toBe(1);
  });

  it('does not mistake the wrapper for a finding', () => {
    // The outer object has `dimensions`; a finding has a name and a verdict.
    const raw = '{"dimensions":[{"name":"a","verdict":"sound","quote":"","why":"fine"}]}';
    expect(parseJudgeReply(raw, bundle).dimensions).toHaveLength(1);
  });
});
