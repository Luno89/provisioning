import { describe, it, expect } from 'vitest';
import {
  prepareInputs, buildInputIndex, buildInlineInputs, inputPath,
  MAX_INLINE_INPUT_CHARS, INPUTS_DIR, type DependencyInput,
} from './dependency-inputs.js';

const input = (n: number, size = 20_000): DependencyInput => ({
  leafId: `11111111-2222-3333-4444-00000000000${n}`,
  title: `Research topic ${n}`,
  findings: 'x'.repeat(size),
});

describe('prompt cost does not scale', () => {
  it('stays flat from four dependencies to forty', () => {
    const four = buildInputIndex(prepareInputs([1, 2, 3, 4].map((n) => input(n))));
    const forty = buildInputIndex(prepareInputs(Array.from({ length: 40 }, (_, i) => input(i))));

    expect(four.length).toBeLessThan(1_000);
    expect(forty.length).toBeLessThan(4_000);
    expect(forty.length).toBeLessThan(prepareInputs([input(1)])[0]!.content.length);
  });

  it('never puts the contents in the prompt', () => {
    const index = buildInputIndex(prepareInputs([input(1)]));
    expect(index).not.toContain('xxxxxxxxxx');
    expect(index).toContain('Research topic 1');
    expect(index).toContain(`${INPUTS_DIR}/`);
  });

  it('states each size, because that is what an agent plans around', () => {
    expect(buildInputIndex(prepareInputs([input(1)]))).toContain('20,000 characters');
  });

  it('tells the agent to read them before writing', () => {
    const index = buildInputIndex(prepareInputs([input(1)]));
    expect(index).toMatch(/read_file/);
    expect(index).toMatch(/nothing in this[\s\S]*prompt summarises them/);
  });

  it('says nothing at all when there are no dependencies', () => {
    expect(buildInputIndex([])).toBe('');
    expect(prepareInputs([])).toEqual([]);
  });
});

describe('the files themselves', () => {
  it('names a file after the work, not just an id', () => {
    const path = inputPath({ leafId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Research Mem0 pipeline' });
    expect(path).toMatch(/^inputs\/research-mem0-pipeline-[a-z0-9]{6}\.md$/);
  });

  it('gives two dependencies with the same title different files', () => {
    const a = inputPath({ leafId: '1111', title: 'Same' });
    const b = inputPath({ leafId: '2222', title: 'Same' });
    expect(a).not.toBe(b);
  });

  it('titles the content, so a file read alone says what it answers', () => {
    expect(prepareInputs([input(1)])[0]!.content).toMatch(/^# Research topic 1/);
  });

  it('skips a dependency that produced nothing', () => {
    expect(prepareInputs([{ leafId: 'x', title: 'Empty', findings: '   ' }])).toEqual([]);
  });
});

describe('the fallback for a persona that cannot read files', () => {
  it('shares ONE budget across inputs rather than capping each', () => {
    const inline = buildInlineInputs(prepareInputs([1, 2, 3, 4].map((n) => input(n))));
    expect(inline.length).toBeLessThan(MAX_INLINE_INPUT_CHARS + 500);
  });

  it('gives every input a share, so none is invisible', () => {
    const inline = buildInlineInputs(prepareInputs([1, 2, 3, 4].map((n) => input(n))));
    for (const n of [1, 2, 3, 4]) expect(inline).toContain(`Research topic ${n}`);
  });

  it('says when it truncated, rather than eliding silently', () => {
    expect(buildInlineInputs(prepareInputs([input(1)]))).toMatch(/truncated — [\d,]+ more characters/);
  });

  it('passes a small input through untouched', () => {
    const inline = buildInlineInputs(prepareInputs([input(1, 200)]));
    expect(inline).not.toMatch(/truncated/);
    expect(inline).toContain('x'.repeat(200));
  });
});
