import { describe, it, expect } from 'vitest';
import { extractLeafMemories, supersede } from './leaf-memory.js';
import type { MemoryItem } from './memory-store.js';

let n = 0;
const input = (over: Partial<Parameters<typeof extractLeafMemories>[0]> = {}) => ({
  leaf: { id: 'l1', ownerId: 'u1', title: 'Write the mapper', projectId: 'p1' },
  trackedFiles: ['package.json', 'src/a.js'],
  summary: 'done',
  succeeded: true,
  missingArtifacts: [],
  now: () => '2026-01-01T00:00:00Z',
  newId: () => `id-${++n}`,
  ...over,
});

describe('what is recorded as fact', () => {
  it('records the repository layout, active immediately', () => {
    const [fact] = extractLeafMemories(input());

    expect(fact?.category).toBe('environment_facts');
    expect(fact?.status).toBe('active');
    expect(fact?.text).toContain('package.json');
    expect(fact?.text).toMatch(/do not survey the tree/i);
  });

  it('scopes the layout to the project', () => {
    expect(extractLeafMemories(input())[0]?.projectId).toBe('p1');
    expect(extractLeafMemories(input())[0]?.scope).toBe('project');
  });

  it('does not claim a project scope it has no project for', () => {
    const [fact] = extractLeafMemories(input({ leaf: { id: 'l1', ownerId: 'u1', title: 't' } }));

    expect(fact?.scope).toBe('global');
    expect(fact?.projectId).toBeUndefined();
  });

  it('records nothing about an empty repository', () => {
    expect(extractLeafMemories(input({ trackedFiles: [] }))).toEqual([]);
  });

  it('lists paths only, never what the files do', () => {
    const [fact] = extractLeafMemories(input({ trackedFiles: ['src/a.js'] }));
    expect(fact?.text).not.toMatch(/exports|implements|provides/i);
  });
});

describe('never writing a memory nothing can read', () => {
  it('scopes to the owner when the leaf has no project', () => {
    const out = extractLeafMemories(input({ leaf: { id: 'l1', ownerId: 'u1', title: 'Research something' }, succeeded: false }));

    expect(out.length).toBeGreaterThan(0);
    for (const m of out) expect(m.scope === 'project' ? Boolean(m.projectId) : true).toBe(true);
    expect(out.every((m) => m.scope === 'global')).toBe(true);
  });

  it('keeps the tighter scope when there is a project', () => {
    const out = extractLeafMemories(input({ succeeded: false }));
    expect(out.every((m) => m.scope === 'project' && m.projectId)).toBe(true);
  });
});

describe('what is recorded when a run fails', () => {
  it('offers an inferred lesson for admission rather than for a queue', () => {
    const out = extractLeafMemories(input({ succeeded: false, summary: 'Ran out of steps (40)' }));
    const lesson = out.find((m) => m.category !== 'environment_facts' || m.title !== 'Repository layout');

    expect(lesson?.status).toBe('active');
  });

  it('recognises the step-exhaustion failure specifically', () => {
    const out = extractLeafMemories(input({ succeeded: false, summary: 'Ran out of steps (40) without calling finish' }));
    expect(out.some((m) => /ran out of steps/i.test(m.title))).toBe(true);
  });

  it('recognises a missing command as an environment problem', () => {
    const out = extractLeafMemories(input({ succeeded: false, verifyOutput: 'sh: pytest: command not found' }));
    const m = out.find((x) => x.title.includes('command'));

    expect(m?.category).toBe('environment_facts');
    expect(m?.status).toBe('active');
  });

  it('records a promised file that never arrived', () => {
    const out = extractLeafMemories(input({ succeeded: false, missingArtifacts: ['src/cli.js(unchanged)'] }));
    expect(out.some((m) => m.text.includes('src/cli.js(unchanged)'))).toBe(true);
  });

  it('records no lesson at all from a successful run', () => {
    const out = extractLeafMemories(input({ succeeded: true }));
    expect(out).toHaveLength(1);
    expect(out[0]?.category).toBe('environment_facts');
  });
});

describe('keeping the bank from becoming the bloat it prevents', () => {
  it('replaces the previous layout rather than stacking another', () => {
    const existing = [{ id: 'old', ownerId: 'u1', projectId: 'p1', title: 'Repository layout' } as MemoryItem];
    const incoming = extractLeafMemories(input());

    const { invalidate } = supersede(existing, incoming, 'NOW');

    expect(invalidate.map((m) => m.id)).toEqual(['old']);
    expect(invalidate[0]!.invalidAt).toBe('NOW');
    expect(invalidate[0]!.supersededBy).toBe(incoming[0]!.id);
  });

  it('does not move the moment an already-retired fact stopped being true', () => {
    const existing = [{
      id: 'old', ownerId: 'u1', projectId: 'p1', title: 'Repository layout', invalidAt: 'EARLIER',
    } as MemoryItem];

    expect(supersede(existing, extractLeafMemories(input()), 'NOW').invalidate).toEqual([]);
  });

  it('does not touch another project\'s layout', () => {
    const existing = [{ id: 'other', ownerId: 'u1', projectId: 'p2', title: 'Repository layout' } as MemoryItem];
    expect(supersede(existing, extractLeafMemories(input())).invalidate).toEqual([]);
  });

  it('does not supersede a lesson', () => {
    const existing = [{ id: 'lesson', ownerId: 'u1', projectId: 'p1', title: 'Failed: something' } as MemoryItem];
    expect(supersede(existing, extractLeafMemories(input())).invalidate).toEqual([]);
  });
});
