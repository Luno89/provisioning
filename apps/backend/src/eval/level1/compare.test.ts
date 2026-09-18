import { describe, it, expect } from 'vitest';
import { compareRuns, type CaseResult, type ComparableRun } from './compare.js';
import type { AttemptRecord } from './attempt.js';

const attempt = (passed: boolean, systemHash = 'aaa'): AttemptRecord => ({
  attempt: 0, passed, systemHash, toolsOffered: [], content: '', thinking: '', toolCalls: [], promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0,
});

const result = (name: string, expects: string | null, passes: boolean[], agent = 'executor', hash = 'aaa'): CaseResult => ({
  name, category: 'simple', agent, expects, attempts: passes.map((passed) => attempt(passed, hash)),
});

const run = (id: string, over: Partial<ComparableRun>): ComparableRun => ({ id, startedAt: '2026-09-17', results: [], ...over });

describe('comparing two eval runs', () => {
  it('says what changed between the runs, including which agents were shown a different prompt', () => {
    const before = run('a', { modelLabel: 'Tabby', toolCatalogueHash: 'x1', results: [result('read', 'read_file', [true], 'executor', 'p1'), result('search', 'search_web', [true], 'research', 'r1')] });
    const after = run('b', { modelLabel: 'Other', toolCatalogueHash: 'x1', sampling: { toolTurn: { temperature: 0.2 } }, results: [result('read', 'read_file', [true], 'executor', 'p2'), result('search', 'search_web', [true], 'research', 'r1')] });

    expect(compareRuns(before, after).differences).toEqual([
      { what: 'model', before: 'Tabby', after: 'Other' },
      { what: 'sampling', before: 'not set', after: '{"toolTurn":{"temperature":0.2}}' },
      { what: "executor's system prompt", before: 'p1', after: 'p2' },
    ]);
  });

  it('shows each case\'s pass rate before and after, worst change first, and cases only one run had', () => {
    const before = run('a', { results: [result('read', 'read_file', [true, true]), result('write', 'write_file', [true, false]), result('gone', null, [true])] });
    const after = run('b', { results: [result('read', 'read_file', [false, false]), result('write', 'write_file', [true, true]), result('new', 'list_dir', [true])] });

    expect(compareRuns(before, after).cases).toEqual([
      { name: 'read', before: { passed: 2, attempts: 2 }, after: { passed: 0, attempts: 2 }, change: -1 },
      { name: 'gone', before: { passed: 1, attempts: 1 }, change: undefined },
      { name: 'new', after: { passed: 1, attempts: 1 }, change: undefined },
      { name: 'write', before: { passed: 1, attempts: 2 }, after: { passed: 2, attempts: 2 }, change: 0.5 },
    ]);
  });

  it('adds up each tool across the cases both runs share', () => {
    const before = run('a', { results: [result('r1', 'read_file', [true, true]), result('r2', 'read_file', [false, false]), result('only-before', 'read_file', [true])] });
    const after = run('b', { results: [result('r1', 'read_file', [true, false]), result('r2', 'read_file', [true, true])] });

    expect(compareRuns(before, after).tools).toEqual([
      { tool: 'read_file', before: { passed: 2, attempts: 4 }, after: { passed: 3, attempts: 4 }, change: 0.25 },
    ]);
  });
});
