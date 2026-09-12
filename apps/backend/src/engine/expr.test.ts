import { describe, it, expect } from 'vitest';
import { compileExpr, referencedPaths, ExprError } from './expr.js';

const scope = {
  reply: { content: 'the answer', thinking: '', finishReason: 'length', toolCalls: [] },
  counters: { rounds: 3, totalTokens: 1200, toolCalls: 0 },
  detectors: { repetition: 0.8, stalled: false },
  children: [{ outcome: 'failed' }],
  outputs: {},
};

const run = (source: string, against: Record<string, unknown> = scope) => compileExpr(source).evaluate(against);

describe('compileExpr', () => {
  it('reads dotted paths off run state', () => {
    expect(run('reply.finishReason == "length"')).toBe(true);
    expect(run('reply.finishReason == "stop"')).toBe(false);
  });

  it('treats a missing path as falsy rather than throwing', () => {
    expect(run('nothing.here.at.all')).toBe(false);
    expect(run('nothing.here == null')).toBe(true);
  });

  it('compares numbers', () => {
    expect(run('counters.rounds > 2')).toBe(true);
    expect(run('counters.rounds >= 3')).toBe(true);
    expect(run('counters.totalTokens < 1000')).toBe(false);
    expect(run('counters.toolCalls != 0')).toBe(false);
  });

  it('combines with and / or / not, honouring precedence', () => {
    expect(run('counters.rounds > 2 and reply.finishReason == "length"')).toBe(true);
    expect(run('counters.rounds > 5 or reply.finishReason == "length"')).toBe(true);
    expect(run('not reply.thinking')).toBe(true);
    expect(run('counters.rounds > 5 and reply.finishReason == "length" or counters.rounds == 3')).toBe(true);
  });

  it('respects parentheses', () => {
    expect(run('(counters.rounds > 5 or counters.rounds == 3) and not detectors.stalled')).toBe(true);
    expect(run('counters.rounds > 5 or (counters.rounds == 3 and detectors.stalled)')).toBe(false);
  });

  it('applies truthiness to bare values', () => {
    expect(run('reply.content')).toBe(true);
    expect(run('reply.thinking')).toBe(false);
    expect(run('reply.toolCalls')).toBe(false);
    expect(run('detectors.repetition')).toBe(true);
  });

  it('supports the helper functions', () => {
    expect(run('empty(reply.toolCalls)')).toBe(true);
    expect(run('empty(reply.content)')).toBe(false);
    expect(run('len(reply.content) > 5')).toBe(true);
    expect(run('contains(reply.content, "answer")')).toBe(true);
    expect(run('startsWith(reply.content, "the")')).toBe(true);
    expect(run('endsWith(reply.content, "answer")')).toBe(true);
    expect(run('matches(reply.finishReason, "^len")')).toBe(true);
  });

  it('handles literals and escaped quotes', () => {
    expect(run('true')).toBe(true);
    expect(run('false')).toBe(false);
    expect(run('"it\'s fine" == "it\'s fine"')).toBe(true);
    expect(run('1_000 < 2000')).toBe(true);
  });

  it('rejects unknown functions, stray characters and unbalanced parens', () => {
    expect(() => compileExpr('dropTable("users")')).toThrow(ExprError);
    expect(() => compileExpr('counters.rounds $ 3')).toThrow(ExprError);
    expect(() => compileExpr('(counters.rounds > 1')).toThrow(ExprError);
    expect(() => compileExpr('counters.rounds > 1)')).toThrow(ExprError);
    expect(() => compileExpr('"unterminated')).toThrow(ExprError);
  });

  it('cannot reach globals or execute anything', () => {
    expect(run('process')).toBe(false);
    expect(run('globalThis')).toBe(false);
    expect(() => compileExpr('process.exit(1)')).toThrow(ExprError);
  });

  it('compiles once and evaluates against different scopes', () => {
    const compiled = compileExpr('counters.rounds > 2');
    expect(compiled.evaluate({ counters: { rounds: 5 } })).toBe(true);
    expect(compiled.evaluate({ counters: { rounds: 1 } })).toBe(false);
    expect(compiled.source).toBe('counters.rounds > 2');
  });
});

describe('referencedPaths', () => {
  it('lists the run-state paths an expression depends on', () => {
    expect(referencedPaths('counters.rounds > 2 and reply.finishReason == "length"').sort())
      .toEqual(['counters.rounds', 'reply.finishReason']);
  });

  it('ignores keywords, literals and function names', () => {
    expect(referencedPaths('not empty(reply.toolCalls) and true')).toEqual(['reply.toolCalls']);
  });
});
