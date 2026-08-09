/**
 * The memory bank was wired into the Lab and nowhere else, so every leaf rediscovered the same
 * repository forever. Measured: three leaves had already built and merged modules when a fourth
 * spent its whole budget twice on `ls -la`, `cat package.json` and `git log`, and never wrote the
 * module it was asked for.
 *
 * The tests that matter here are about the ACTIVE/PENDING split — auto-extracted memory is read by
 * every future leaf on the project, and a wrong lesson is worse than no lesson because it gets
 * confidently repeated.
 */
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
    /**
     * Read off git, so it cannot be wrong the way an inference can — which is the entire reason it
     * is allowed to take effect without a human. It is also the half that stops the rediscovery.
     */
    const [fact] = extractLeafMemories(input());

    expect(fact?.category).toBe('environment_facts');
    expect(fact?.status).toBe('active');
    expect(fact?.text).toContain('package.json');
    expect(fact?.text).toMatch(/do not survey the tree/i);
  });

  it('scopes the layout to the project', () => {
    // Another project's file listing is noise at best and misleading at worst.
    expect(extractLeafMemories(input())[0]?.projectId).toBe('p1');
    expect(extractLeafMemories(input())[0]?.scope).toBe('project');
  });

  it('is useless without a project id, so that must be supplied', () => {
    /**
     * A project-scoped memory with no projectId is excluded by buildMemoryContext for every
     * project — written, active, and unreadable. It happened: the leaf record only gains its
     * projectId after the memory is extracted, so the caller has to pass the resolved one.
     */
    const [fact] = extractLeafMemories(input({ leaf: { id: 'l1', ownerId: 'u1', title: 't' } }));

    expect(fact?.scope).toBe('project');
    expect(fact?.projectId).toBeUndefined();
  });

  it('records nothing about an empty repository', () => {
    expect(extractLeafMemories(input({ trackedFiles: [] }))).toEqual([]);
  });

  it('lists paths only, never what the files do', () => {
    // A summary of purpose would be an inference, and would go stale the moment a leaf edited one.
    const [fact] = extractLeafMemories(input({ trackedFiles: ['src/a.js'] }));
    expect(fact?.text).not.toMatch(/exports|implements|provides/i);
  });
});

describe('what is recorded only for a human to approve', () => {
  it('holds an inferred lesson back for review', () => {
    // buildMemoryContext excludes pending_review, so nothing a model concluded reaches a future
    // prompt until somebody agrees to it.
    const out = extractLeafMemories(input({ succeeded: false, summary: 'Ran out of steps (40)' }));
    const lesson = out.find((m) => m.category !== 'environment_facts' || m.title !== 'Repository layout');

    expect(lesson?.status).toBe('pending_review');
  });

  it('recognises the step-exhaustion failure specifically', () => {
    const out = extractLeafMemories(input({ succeeded: false, summary: 'Ran out of steps (40) without calling finish' }));
    expect(out.some((m) => /ran out of steps/i.test(m.title))).toBe(true);
  });

  it('recognises a missing command as an environment problem', () => {
    // Still pending: which command is missing is read off the output, but "the image needs it" is
    // the inference.
    const out = extractLeafMemories(input({ succeeded: false, verifyOutput: 'sh: pytest: command not found' }));
    const m = out.find((x) => x.title.includes('command'));

    expect(m?.category).toBe('environment_facts');
    expect(m?.status).toBe('pending_review');
  });

  it('records a promised file that never arrived', () => {
    const out = extractLeafMemories(input({ succeeded: false, missingArtifacts: ['src/cli.js(unchanged)'] }));
    expect(out.some((m) => m.text.includes('src/cli.js(unchanged)'))).toBe(true);
  });

  it('records no lesson at all from a successful run', () => {
    // "It worked" is not worth carrying into every future prompt on the project.
    const out = extractLeafMemories(input({ succeeded: true }));
    expect(out).toHaveLength(1);
    expect(out[0]?.category).toBe('environment_facts');
  });
});

describe('keeping the bank from becoming the bloat it prevents', () => {
  it('replaces the previous layout rather than stacking another', () => {
    // Every leaf produces one. Ten leaves would otherwise carry ten near-identical listings into
    // every prompt.
    const existing = [{ id: 'old', ownerId: 'u1', projectId: 'p1', title: 'Repository layout' } as MemoryItem];
    const incoming = extractLeafMemories(input());

    expect(supersede(existing, incoming).remove).toEqual(['old']);
  });

  it('does not touch another project\'s layout', () => {
    const existing = [{ id: 'other', ownerId: 'u1', projectId: 'p2', title: 'Repository layout' } as MemoryItem];
    expect(supersede(existing, extractLeafMemories(input())).remove).toEqual([]);
  });

  it('does not supersede a lesson', () => {
    // Lessons accumulate; only the layout is a single current truth.
    const existing = [{ id: 'lesson', ownerId: 'u1', projectId: 'p1', title: 'Failed: something' } as MemoryItem];
    expect(supersede(existing, extractLeafMemories(input())).remove).toEqual([]);
  });
});
