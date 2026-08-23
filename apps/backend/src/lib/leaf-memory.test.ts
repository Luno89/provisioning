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

  it('does not claim a project scope it has no project for', () => {
    /**
     * This used to assert `scope: 'project'` with no `projectId` — the shape its own comment
     * described as "written, active, and unreadable", because `buildMemoryContext` gives a
     * project-scoped memory to a leaf only when the ids match. It was a warning that the caller
     * must pass the resolved project, and the warning was not enough: 25 such rows existed on this
     * instance, none of which had ever reached a prompt.
     *
     * The caller contract still holds — the leaf record only gains its projectId after extraction,
     * so `ExecuteLeafActivity` passes the resolved one — but getting it wrong now costs a wider
     * scope rather than silent invisibility.
     */
    const [fact] = extractLeafMemories(input({ leaf: { id: 'l1', ownerId: 'u1', title: 't' } }));

    expect(fact?.scope).toBe('global');
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

describe('never writing a memory nothing can read', () => {
  /**
   * A `scope: 'project'` row with no `projectId` matches no leaf at all — `buildMemoryContext`
   * requires the ids to be equal. This wrote 25 of them before it was noticed, because the scope
   * was a constant while the project was conditional.
   */
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
    /**
     * This asserted `pending_review`, on the rule that nothing a model concluded reaches a future
     * prompt without somebody agreeing to it. The rule stands; the queue did not — 124 of 143
     * memories were sitting in it unread, so lessons from failures reached nothing, ever.
     *
     * `active` here means eligible, not kept: `admitMemory` still decides against the entries
     * already stored, and every retirement it causes is reversible.
     */
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

    const { invalidate } = supersede(existing, incoming, 'NOW');

    /**
     * Retired, not removed. The row survives so that "what did the harness believe when this leaf
     * ran" stays answerable — failure review and the judge both ask it — and so that a wrong
     * supersession is a field to clear rather than information destroyed.
     */
    expect(invalidate.map((m) => m.id)).toEqual(['old']);
    expect(invalidate[0]!.invalidAt).toBe('NOW');
    expect(invalidate[0]!.supersededBy).toBe(incoming[0]!.id);
  });

  it('does not move the moment an already-retired fact stopped being true', () => {
    // Re-stamping on every later run would make `invalidAt` mean "the last time a leaf finished".
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
    // Lessons accumulate; only the layout is a single current truth.
    const existing = [{ id: 'lesson', ownerId: 'u1', projectId: 'p1', title: 'Failed: something' } as MemoryItem];
    expect(supersede(existing, extractLeafMemories(input())).invalidate).toEqual([]);
  });
});
