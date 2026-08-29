import { describe, it, expect } from 'vitest';
import { buildConfigExport, parseConfigExport, CONFIG_EXPORT_VERSION } from './config-export.js';
import type { Experiment, HarnessProfile } from '@koala/harness-types';

const experiment = (over: Partial<Experiment> = {}): Experiment => ({
  id: 'e1', ownerId: 'u1', name: 'prompt types', language: 'node',
  tasks: [{ id: 't1', name: 'fib', prompt: 'write fib', verifyCommand: 'node t.js' }],
  variants: [{ label: 'a', overrides: { think: true } }],
  repeats: 2, status: 'complete',
  results: [{
    label: 'a', taskId: 't1', succeeded: true, verified: true, verifyExitCode: 0,
    verifyOutput: 'PASS', steps: 4, tokensUsed: 900, durationMs: 1000,
    summary: 'ok', transcript: [], trace: [{ step: 1, toolCalls: [], toolResults: [], tokens: 10 }],
  }],
  createdAt: 'a', updatedAt: 'b', ...over,
});

const profile: HarnessProfile = {
  ownerId: 'u1',
  overrides: { systemPrompt: 'terse' },
  from: {
    experimentId: 'e1', experimentName: 'prompt types', variantLabel: 'a',
    verified: 2, runs: 2, tasks: 1, wasBest: true, promotedAt: 'x',
  },
  updatedAt: 'x',
};

describe('buildConfigExport', () => {
  it('carries the question and not the answers', () => {
    const out = buildConfigExport([experiment()], null, 'now');
    expect(JSON.stringify(out)).not.toMatch(/trace|verified|tokensUsed/);
    expect(out.suites[0]!.tasks[0]!.prompt).toBe('write fib');
    expect(out.suites[0]!.variants).toEqual([{ label: 'a', overrides: { think: true } }]);
  });

  it('drops task ids, which are positional and assigned on create', () => {
    expect(out()).not.toHaveProperty('id');
    function out() { return buildConfigExport([experiment()], null).suites[0]!.tasks[0]!; }
  });

  it('carries the adopted defaults with the evidence that earned them', () => {
    const out = buildConfigExport([], profile);
    expect(out.profile!.overrides).toEqual({ systemPrompt: 'terse' });
    expect(out.profile!.from!.experimentName).toBe('prompt types');
  });

  it('omits a profile that adopts nothing', () => {
    expect(buildConfigExport([], { ownerId: 'u', overrides: {}, updatedAt: 'x' }).profile).toBeUndefined();
  });

  it('round-trips through parse', () => {
    const parsed = parseConfigExport(JSON.parse(JSON.stringify(buildConfigExport([experiment()], profile))));
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.suites).toHaveLength(1);
    expect(parsed.suites[0]!.tasks[0]!.verifyCommand).toBe('node t.js');
    expect(parsed.profile!.overrides).toEqual({ systemPrompt: 'terse' });
  });
});

describe('parseConfigExport', () => {
  it('refuses a file from a newer harness rather than reading it partially', () => {
    const out = parseConfigExport({ version: CONFIG_EXPORT_VERSION + 1, suites: [] });
    expect(out).toEqual({ error: expect.stringMatching(/reads up to/) });
  });

  it('refuses something that is not an export at all', () => {
    expect(parseConfigExport('nope')).toEqual({ error: expect.any(String) });
    expect(parseConfigExport({ suites: [] })).toEqual({ error: expect.stringMatching(/version/) });
  });

  it('names what it skipped rather than importing a shorter suite silently', () => {
    const out = parseConfigExport({
      version: 1,
      suites: [
        { name: 'good', tasks: [{ name: 't', prompt: 'p', verifyCommand: 'v' }], variants: [{ label: 'a', overrides: {} }], repeats: 1 },
        { name: 'no tasks', tasks: [], variants: [{ label: 'a', overrides: {} }], repeats: 1 },
        { name: 'no variants', tasks: [{ name: 't', prompt: 'p', verifyCommand: 'v' }], variants: [], repeats: 1 },
        { tasks: [], variants: [], repeats: 1 },
      ],
    });
    if ('error' in out) throw new Error('should have parsed');
    expect(out.suites.map((s) => s.name)).toEqual(['good']);
    expect(out.rejected).toEqual(['no tasks: no usable tasks', 'no variants: no variants', 'suite 4: no name']);
  });

  it('drops a task missing the field that makes it measurable', () => {
    const out = parseConfigExport({
      version: 1,
      suites: [{
        name: 's',
        tasks: [
          { name: 'ok', prompt: 'p', verifyCommand: 'v' },
          { name: 'unverifiable', prompt: 'p' },
        ],
        variants: [{ label: 'a', overrides: {} }],
        repeats: 1,
      }],
    });
    if ('error' in out) throw new Error('should have parsed');
    expect(out.suites[0]!.tasks.map((t) => t.name)).toEqual(['ok']);
  });
});
